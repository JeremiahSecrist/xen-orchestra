
import assert from 'node:assert'
import execa from 'execa'
import LocalHandler from './local'
import fs from 'fs-extra'
import { normalize as normalizePath } from './path'
import { createHash, randomBytes } from 'node:crypto'
import { asyncEach } from '@vates/async-each'
import { fromCallback, ignoreErrors } from 'promise-toolbox'

export default class DedupedLocalHandler extends LocalHandler {
  #dedupDirectory = '/xo-block-store'
  #hashMethod = 'sha256'
  #attributeKey = `user.hash.${this.#hashMethod}`

  #hash(data) {
    return createHash(this.#hashMethod).update(data).digest('hex')
  }

  // even in a deduplicated handler, dedup is opt in
  async _writeFile(file, data, { flags, dedup }) {
    if (dedup === true) {
      const hash = this.#hash(data)
      // create the file (if not already present) in the store
      const dedupPath = await this.#writeDeduplicationSource(hash, data)
      // hard link to the target place
      // this linked file will have the same extended attributes
      // (used for unlink)
      return this.#link(dedupPath, file)
    }
    // fallback
    return super._writeFile(file, data, { flags })
  }

  async _unlink(file) {
    let hash
    try {
      // get hash before deleting the file
      hash = await this.#getExtendedAttribute(file, this.#attributeKey)
    } catch (err) {
      // attributes unknown (a non duplicated file)
      // whatever : fall back to normal delete
    }

    // delete file in place
    await super._unlink(file)

    if (hash) {
      const dedupPath = this.getFilePath(this.#computeDeduplicationPath(hash))
      try{
        const { nlink } = await fs.stat(dedupPath)
        // get the number of copy still using these data
        // delete source if it's alone
        if (nlink === 1) {
          await fs.unlink(dedupPath)
        } 
      }catch(error){
        // no problem if another process deleted the source or if we unlink directly the source file
        if(error.code !== 'ENOENT'){
          throw error
        }
      }
    }
  }

  // @todo : use a multiplatform package instead
  async #getExtendedAttribute(file, attribueName) {
    const {stdout} = await execa('getfattr', ['-n', attribueName, '--only-value', this.getFilePath(file)])
    return stdout
  }
  async #setExtendedAttribute(file, attribueName, value) {
    await execa('setfattr', ['-n', attribueName, '-v', value, this.getFilePath(file)])
  }

  // create a hard link between to files
  #link(source, dest) {
    return fs.link(this.getFilePath(source), this.getFilePath(dest))
  }

  // split path to keep a sane number of file per directory
  #computeDeduplicationPath(hash) {
    assert.strictEqual(hash.length % 4, 0)
    let path = this.#dedupDirectory
    for (let i = 0; i < hash.length; i++) {
      if (i % 4 === 0) {
        path += '/'
      }
      path += hash[i]
    }
    path += '.source'
    return path
  }

  async #writeDeduplicationSource(hash, data) {
    const path = this.#computeDeduplicationPath(hash)
    try {
      // flags ensures it fails if it already exists
      await this._outputFile(path, data, { flags: 'wx' })
    } catch (error) {
      // if it is alread present : not a problem
      if (error.code === 'EEXIST') {
        // it should already have the extended attributes, nothing more to do
        return 
      }
      throw error
    }

    try {
      await this.#setExtendedAttribute(path, this.#attributeKey, hash)
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error
      }
      console.warn('deleted by concurrent')
      // if a concurrent process deleted the dedup : recreate it
      return this.#writeDeduplicationSource(path, hash)
    }
    return path
  }

  /**
   * delete empty dirs
   * delete file source thath don't have any more links
   * 
   * @returns Promise
   */

  async deduplicationGarbageCollector(dir = this.#dedupDirectory){
    try {
      return await this._rmdir(dir)
    } catch (error) {
      if (error.code !== 'ENOTEMPTY') {
        throw error
      }
    }

    const files = await this._list(dir)
    await asyncEach(files, async  file =>{
      const stat = await fs.stat(file)
      // have to check the stat to ensure we don't try to delete 
      // the directories : they d'ont have links
      if(stat.isDirectory()){
        return this.deduplicationGarbageCollector(`${dir}/${file}`)
      }
      if(stat.nlink === 1){
        return fs.unlink(`${dir}/${file}`)
      }

    })
    return this._rmtree(dir)

  }


  async checkSupport(){
    const supported =super.checkSupport()
    const sourceFileName = normalizePath(`${Date.now()}.sourcededup`)
    const destFileName = normalizePath(`${Date.now()}.destdedup`)
    try{
      const SIZE = 1024 * 1024
      const data = await fromCallback(randomBytes, SIZE)
      const hash = this.#hash(data)
      await this._outputFile(sourceFileName, data, { flags: 'wx' })
      await this.#setExtendedAttribute(sourceFileName, this.#attributeKey, hash)
      await this.#link(sourceFileName, destFileName)
      supported.dedup =  (hash === await this.#getExtendedAttribute(sourceFileName, this.#attributeKey))
    } catch (error) {
      warn(`error while testing the dedup`, { error })
    } finally {
      ignoreErrors.call(this._unlink(sourceFileName))
      ignoreErrors.call(this._unlink(destFileName))
    }
    return supported

  }
}
