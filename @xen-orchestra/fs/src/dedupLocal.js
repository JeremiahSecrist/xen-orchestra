import execa from 'execa'
import LocalHandler from './local'
import fs from 'fs-extra'
import assert from 'node:assert'
import { createHash } from 'node:crypto';

export default class DedupedLocalHandler extends LocalHandler {
  #dedupFolder = '/xo-block-store'
  #hashMethod  = 'sha256'
  #attributeKey = `user.hash.${this.#hashMethod}`


  async _sync(){
    await super._sync()
      await this.mkdir(this.#dedupFolder)
  }

  // even in a deduplicated handler, dedup is opt in
  async _writeFile(file, data, { flags, dedup }) {
    if (dedup === true) {
      // create the file (if not already present) in the store
      const hash = createHash(this.#hashMethod).update(data).digest('hex')
      assert.notStrictEqual(hash, undefined, 'Hash must be defined for deduplication to work ')
      const dedupPath = await this.#writeDeduplicationSource(hash, data)
      // hard link to the target place
      // this linked file will have the same extended attributes
      // (used for unlink)
      return this.#link(dedupPath, file)
    }
    // fallback
    return super._writeFile(file, data, { flags })
  }

  // this is slower than the non dedup method 
  async _unlink(file) {
    // get hash
    let hash 
    try{
      hash = await this.#getExtendedAttribute(file, this.#attributeKey)
    }catch(err){
      // attributes unknown ( a non duplicated file)
      // whatever : fall back to normal delete 
    }

    // delete file
    await super._unlink(file)

    if (hash) {
      const dedupPath = this.getFilePath(this.#computeDeduplicationPath(hash))
      const { nlink } = await fs.stat(dedupPath)
      // get the number of copy still using these data
      // delete source if it's alone
      if (nlink === 1) {
        const dedupPath = this.getFilePath(this.#computeDeduplicationPath(hash))
        await fs.unlink(dedupPath)
      }
    } 
  }
  
  // @todo : use a multiplatform package instead
  async #getExtendedAttribute(file, attribueName) { 
    const value = await execa('getfattr', ['-n',attribueName, '--only-value', this.getFilePath(file)])
    return value
  }
  async #setExtendedAttribute(file, attribueName, value) {
    await execa('setfattr', ['-n',attribueName,'-v',value,  this.getFilePath(file)])
  }

  // create a hard link between to files
  #link(source, dest) {
    return fs.link(this.getFilePath(source), this.getFilePath(dest))
  }

  // split path to keep a sane number of file per directory
  #computeDeduplicationPath(hash) {
    assert.strictEqual(hash.length % 4 , 0)
    let path = this.#dedupFolder
    for (let i = 0; i < hash.length; i++) {
      if (i % 4 === 0) {
        path += '/'
      }
      path += hash[i]
    }
    path += hash + '.source'
    return path
  }


  async #writeDeduplicationSource( hash, data) {
    const path = this.#computeDeduplicationPath(hash) 
    try {
      // flags ensures it fails if it already exists 
      await this._outputFile(path,data, { flags: 'wx' })
    } catch (error) {
      // if it is alread present : not a problem
      if (error.code !== 'EEXIST') {
        throw error
      }
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
}
