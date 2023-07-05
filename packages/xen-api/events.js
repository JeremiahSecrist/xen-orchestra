'use strict'

const EVENT_TIMEOUT = 60e3

class Watcher {
  #abortController
  watchedTypes = new Map()
  xapi

  constructor(xapi) {
    this.xapi = xapi
  }

  async #start() {
    const { xapi } = this
    const { signal } = this.#abortController

    let fromToken = await xapi.call('event.inject', 'pool', xapi.pool.$ref)

    while (true) {
      signal.throwIfRequested()

      const events = await xapi.call({ signal }, 'event.from', this.watchedTypes, fromToken, EVENT_TIMEOUT)
    }
    this.#abortController = undefined
  }

  start() {
    if (this.#abortController !== undefined) {
      throw new Error('already started')
    }

    this.#abortController = new AbortController()
    this.#start()
  }

  stop() {
    if (this.#abortController === undefined) {
      throw new Error('already stopped')
    }

    this.#abortController.abort()
  }
}
exports.Watcher = Watcher

class Cache {
  // contains records indexed by type + ref
  //
  // plain records when retrieved by events
  //
  // promises to record when retrieved by a get_record call (might be a rejection if the record does not exist)
  #recordCache = new Map()
  #watcher

  constructor(watcher) {
    this.#watcher = watcher
  }

  async #get(type, ref) {
    let record
    try {
      record = await this.#watcher.xapi.get(type, ref)
    } catch (error) {
      if (error.code !== 'HANDLE_INVALID') {
        throw error
      }
      record = Promise.reject(error)
    }
    this.#recordCache.set(type, Promise.resolve(record))
    return record
  }

  async get(type, ref) {
    const cache = this.#recordCache
    const key = type + ref

    let record = cache.get(key)
    if (record === undefined) {
      record = this.#get(type, ref)
      cache.set(key, record)
    }

    return record
  }
}
exports.Cache = Cache
