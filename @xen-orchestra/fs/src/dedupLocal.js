import execa from 'execa'
import LocalHandler from './local'
import fs from 'fs-extra'
import assert from 'node:assert'
import { createHash } from 'node:crypto'

export default class DedupedLocalHandler extends LocalHandler {
  #dedupFolder = '/xo-block-store'
  #hashMethod = 'sha256'
  #attributeKey = `user.hash.${this.#hashMethod}`

  async _sync() {
    await super._sync()
    await this.mkdir(this.#dedupFolder)
  }

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
    let path = this.#dedupFolder
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
}
