import { asyncEach } from '@vates/async-each'
import { every } from '@vates/predicates'
import { ifDef } from '@xen-orchestra/defined'
import { featureUnauthorized, invalidCredentials, noSuchObject } from 'xo-common/api-errors.js'
import { pipeline } from 'node:stream/promises'
import { json, Router } from 'express'
import path from 'node:path'
import pick from 'lodash/pick.js'
import keyBy from 'lodash/keyBy.js'
import * as CM from 'complex-matcher'
import { VDI_FORMAT_RAW, VDI_FORMAT_VHD } from '@xen-orchestra/xapi'

const { join } = path.posix
const noop = Function.prototype

async function* makeObjectsStream(iterable, makeResult, json) {
  // use Object.values() on non-iterable objects
  if (
    iterable != null &&
    typeof iterable === 'object' &&
    typeof iterable[Symbol.iterator] !== 'function' &&
    typeof iterable[Symbol.asyncIterator] !== 'function'
  ) {
    iterable = Object.values(iterable)
  }

  if (json) {
    yield '['
    let first = true
    for await (const object of iterable) {
      if (first) {
        first = false
        yield '\n'
      } else {
        yield ',\n'
      }
      yield JSON.stringify(makeResult(object), null, 2)
    }
    yield '\n]\n'
  } else {
    for await (const object of iterable) {
      yield JSON.stringify(makeResult(object))
      yield '\n'
    }
  }
}

async function sendObjects(iterable, req, res, path = req.path) {
  const { query } = req

  const basePath = join(req.baseUrl, path)
  const makeUrl = ({ id }) => join(basePath, typeof id === 'number' ? String(id) : id)

  let makeResult
  let { fields } = query
  if (fields === undefined) {
    makeResult = makeUrl
  } else if (fields === '*') {
    makeResult = object => ({
      ...object,
      href: makeUrl(object),
    })
  } else if (fields) {
    fields = fields.split(',')
    makeResult = object => {
      const url = makeUrl(object)
      object = pick(object, fields)
      object.href = url
      return object
    }
  }

  const json = !Object.hasOwn(query, 'ndjson')

  res.setHeader('content-type', json ? 'application/json' : 'application/x-ndjson')
  return pipeline(makeObjectsStream(iterable, makeResult, json, res), res)
}

const handleOptionalUserFilter = filter => filter && CM.parse(filter).createPredicate()

const subRouter = (app, path) => {
  const router = Router({ strict: false })
  app.use(path, router)
  return router
}

// wraps an async middleware
function wrap(middleware, handleNoSuchObject = false) {
  return async function asyncMiddlewareWrapped(req, res, next) {
    try {
      await middleware.apply(this, arguments)
    } catch (error) {
      if (featureUnauthorized.is(error)) {
        res.sendStatus(403)
      } else if (handleNoSuchObject && noSuchObject.is(error)) {
        res.sendStatus(404)
      } else {
        next(error)
      }
    }
  }
}

export default class RestApi {
  constructor(app, { express }) {
    // don't setup the API if express is not present
    //
    // that can happen when the app is instanciated in another context like xo-server-recover-account
    if (express === undefined) {
      return
    }

    const api = subRouter(express, '/rest/v0')

    api.use(({ cookies }, res, next) => {
      app.authenticateUser({ token: cookies.authenticationToken ?? cookies.token }).then(
        ({ user }) => {
          if (user.permission === 'admin') {
            return next()
          }

          res.sendStatus(401)
        },
        error => {
          if (invalidCredentials.is(error)) {
            res.sendStatus(401)
          } else {
            next(error)
          }
        }
      )
    })

    const types = [
      'host',
      'network',
      'pool',
      'SR',
      'VBD',
      'VDI-snapshot',
      'VDI',
      'VIF',
      'VM-snapshot',
      'VM-template',
      'VM',
    ]
    const collections = Object.fromEntries(
      types.map(type => {
        const id = type.toLocaleLowerCase() + 's'
        return [id, { id, isCorrectType: _ => _.type === type, type }]
      })
    )

    collections.backups = { id: 'backups' }
    collections.restore = { id: 'restore' }
    collections.tasks = { id: 'tasks' }

    collections.hosts.routes = {
      __proto__: null,

      async missing_patches(req, res) {
        await app.checkFeatureAuthorization('LIST_MISSING_PATCHES')

        const host = req.xapiObject
        res.json(await host.$xapi.listMissingPatches(host))
      },
    }

    collections.pools.routes = {
      __proto__: null,

      async missing_patches(req, res) {
        await app.checkFeatureAuthorization('LIST_MISSING_PATCHES')

        const xapi = req.xapiObject.$xapi
        const missingPatches = new Map()
        await asyncEach(Object.values(xapi.objects.indexes.type.host ?? {}), async host => {
          try {
            for (const patch of await xapi.listMissingPatches(host)) {
              const { uuid: key = `${patch.name}-${patch.version}-${patch.release}` } = patch
              missingPatches.set(key, patch)
            }
          } catch (error) {
            console.warn(host.uuid, error)
          }
        })
        res.json(Array.from(missingPatches.values()))
      },
    }

    collections.pools.actions = {
      __proto__: null,

      rolling_update: async ({ xoObject }) => {
        await app.checkFeatureAuthorization('ROLLING_POOL_UPDATE')

        await app.rollingPoolUpdate(xoObject)
      },
    }
    collections.vms.actions = {
      __proto__: null,

      clean_reboot: ({ xapiObject: vm }) => vm.$callAsync('clean_reboot').then(noop),
      clean_shutdown: ({ xapiObject: vm }) => vm.$callAsync('clean_shutdown').then(noop),
      hard_reboot: ({ xapiObject: vm }) => vm.$callAsync('hard_reboot').then(noop),
      hard_shutdown: ({ xapiObject: vm }) => vm.$callAsync('hard_shutdown').then(noop),
      snapshot: async ({ xapiObject: vm }, { name_label }) => {
        const ref = await vm.$snapshot({ name_label })
        return vm.$xapi.getField('VM', ref, 'uuid')
      },
      start: ({ xapiObject: vm }) => vm.$callAsync('start', false, false).then(noop),
    }

    api.param('collection', (req, res, next) => {
      const id = req.params.collection
      const collection = collections[id]
      if (collection === undefined) {
        next('route')
      } else {
        req.collection = collection
        next()
      }
    })
    api.param('object', (req, res, next) => {
      const id = req.params.object
      const { type } = req.collection
      try {
        req.xapiObject = app.getXapiObject((req.xoObject = app.getObject(id, type)))
        next()
      } catch (error) {
        if (noSuchObject.is(error, { id, type })) {
          next('route')
        } else {
          next(error)
        }
      }
    })

    api.get(
      '/',
      wrap((req, res) => sendObjects(collections, req, res))
    )

    api
      .get(
        '/backups',
        wrap((req, res) => sendObjects([{ id: 'jobs' }, { id: 'logs' }], req, res))
      )
      .get(
        '/backups/jobs',
        wrap(async (req, res) => sendObjects(await app.getAllJobs('backup'), req, res))
      )
      .get(
        '/backups/jobs/:id',
        wrap(async (req, res) => {
          res.json(await app.getJob(req.params.id, 'backup'))
        })
      )
      .get(
        '/backups/logs',
        wrap(async (req, res) => {
          const logs = await app.getBackupNgLogsSorted({
            filter: ({ message: m }) => m === 'backup' || m === 'metadata',
          })
          await sendObjects(logs, req, res)
        })
      )
      .get(
        '/restore',
        wrap((req, res) => sendObjects([{ id: 'logs' }], req, res))
      )
      .get(
        '/restore/logs',
        wrap(async (req, res) => {
          const logs = await app.getBackupNgLogsSorted({ filter: _ => _.message === 'restore' })
          await sendObjects(logs, req, res)
        })
      )
      .get(
        ['/backups/logs/:id', '/restore/logs/:id'],
        wrap(async (req, res) => {
          res.json(await app.getBackupNgLogs(req.params.id))
        })
      )

    api.get('/appliance', (req, res) => {
      res.json({ id: 'cf27a74a-03c9-0b8d-5b97-4fd1a74420a8' })
    })

    let xoConfigEnabled = true
    const xoConfigBackups = keyBy(
      [
        {
          content: '/rest/v0/cloud/xo-config/backups/27/config.json.gz.enc',
          created_at: 1687786089427,
          id: 27,
          license_id: 'l_JDJ5JDEwJHVkcmhFZXg4Y3RCbUMvZEw1SGhEUmVaQ2VRdVVXLkVqOVh2MGF3R2hvNW9HSG5VMFZneDdX',
          xoa_id: 'cf27a74a-03c9-0b8d-5b97-4fd1a74420a8',
        },
        {
          content: '/rest/v0/cloud/xo-config/backups/28/config.json.gz',
          created_at: 1687792298264,
          id: 28,
          license_id: 'foo bar',
          xoa_id: '218b43e8-5622-4d81-adce-69be4252c4de',
        },
      ],
      'id'
    )
    api
      .get(
        '/cloud/xo-config',
        wrap(async (req, res) => {
          res.json({ enabled: xoConfigEnabled, passphrase: '*obfuscated*' })
        })
      )
      .patch('/cloud/xo-config', json(), async (req, res) => {
        const { enabled, passphrase } = req.body
        if (typeof enabled === 'boolean') {
          xoConfigEnabled = enabled
        }
        if (typeof passphrase === 'string') {
          // todo
        }
        res.sendStatus(200)
      })
      .get(
        '/cloud/xo-config/backups',
        wrap(async (req, res) => {
          let configs = Object.values(xoConfigBackups)

          const { limit, filter } = req.query
          if (filter !== undefined) {
            configs = configs.filter(CM.parse(filter).createPredicate())
          }
          configs.sort((a, b) => a.created_at - b.created_at)
          if (limit !== undefined) {
            configs.length = Math.min(limit, configs.length)
          }

          await sendObjects(configs, req, res)
        })
      )
      .get(
        '/cloud/xo-config/backups/:id',
        wrap(async (req, res, next) => {
          const config = xoConfigBackups[req.params.id]
          if (config === undefined) {
            return next()
          }
          res.json(config)
        })
      )
      .get(
        '/cloud/xo-config/backups/:id/config.*',
        wrap(async (req, res, next) => {
          const config = xoConfigBackups[req.params.id]
          if (config === undefined || config.content !== req.path) {
            return next()
          }

          res.send(Buffer.from('wy4ECQMIc4yNxo6eZRbgfh7jWmidLE88zlxCIRM4izMr9cPkz7/JaWt', 'base64'))
        })
      )
      .get(
        '/cloud/xo-config/backups/:id/actions',
        wrap(async (req, res) => {
          await sendObjects([{ id: 'import' }], req, res)
        })
      )
      .post(
        '/cloud/xo-config/backups/:id/actions/import',
        json(),
        wrap((req, res) => {
          res.sendStatus(200)
        })
      )

    api
      .get(
        '/tasks',
        wrap(async (req, res) => {
          const { filter, limit } = req.query
          const tasks = app.tasks.list({
            filter: handleOptionalUserFilter(filter),
            limit: ifDef(limit, Number),
          })
          await sendObjects(tasks, req, res)
        })
      )
      .delete(
        '/tasks',
        wrap(async (req, res) => {
          await app.tasks.clearLogs()
          res.sendStatus(200)
        })
      )
      .get(
        '/tasks/:id',
        wrap(async (req, res) => {
          const {
            params: { id },
            query: { wait },
          } = req
          if (wait !== undefined) {
            const stopWatch = await app.tasks.watch(id, task => {
              if (wait !== 'result' || task.status !== 'pending') {
                stopWatch()
                res.json(task)
              }
            })
            req.on('close', stopWatch)
          } else {
            res.json(await app.tasks.get(id))
          }
        }, true)
      )
      .delete(
        '/tasks/:id',
        wrap(async (req, res) => {
          await app.tasks.deleteLog(req.params.id)
          res.sendStatus(200)
        })
      )
      .get(
        '/tasks/:id/actions',
        wrap(async (req, res) => {
          const task = await app.tasks.get(req.params.id)

          await sendObjects(task.status === 'pending' ? [{ id: 'abort' }] : [], req, res)
        })
      )
      .post(
        '/tasks/:id/actions/abort',
        wrap(async (req, res) => {
          const { id } = req.params
          await app.tasks.abort(id)
          res.status = 202
          res.end(req.baseUrl + '/tasks/' + id)
        }, true)
      )

    api.get(
      '/:collection',
      wrap(async (req, res) => {
        const { query } = req
        await sendObjects(
          await app.getObjects({
            filter: every(req.collection.isCorrectType, handleOptionalUserFilter(query.filter)),
            limit: ifDef(query.limit, Number),
          }),
          req,
          res
        )
      })
    )

    // should go before routes /:collection/:object because they will match but
    // will not work due to the extension being included in the object identifer
    api.get(
      '/:collection(vdis|vdi-snapshots)/:object.:format(vhd|raw)',
      wrap(async (req, res) => {
        const stream = await req.xapiObject.$exportContent({ format: req.params.format })

        stream.headers['content-disposition'] = 'attachment'
        res.writeHead(stream.statusCode, stream.statusMessage != null ? stream.statusMessage : '', stream.headers)

        await pipeline(stream, res)
      })
    )
    api.get(
      '/:collection(vms|vm-snapshots|vm-templates)/:object.xva',
      wrap(async (req, res) => {
        const stream = await req.xapiObject.$export({ compress: req.query.compress })

        stream.headers['content-disposition'] = 'attachment'
        res.writeHead(stream.statusCode, stream.statusMessage != null ? stream.statusMessage : '', stream.headers)

        await pipeline(stream, res)
      })
    )

    api.get('/:collection/:object', (req, res) => {
      let result = req.xoObject

      // add locations of sub-routes for discoverability
      const { routes } = req.collection
      if (routes !== undefined) {
        result = { ...result }
        for (const route of Object.keys(routes)) {
          result[route + '_href'] = join(req.baseUrl, req.path, route)
        }
      }

      res.json(result)
    })
    api.patch(
      '/:collection/:object',
      json(),
      wrap(async (req, res) => {
        const obj = req.xapiObject

        const promises = []
        const { body } = req
        for (const key of ['name_description', 'name_label']) {
          const value = body[key]
          if (value !== undefined) {
            promises.push(obj['set_' + key](value))
          }
        }
        await promises
        res.sendStatus(204)
      })
    )

    api.get(
      '/:collection/:object/tasks',
      wrap(async (req, res) => {
        const { query } = req
        const objectId = req.xoObject.id
        const tasks = app.tasks.list({
          filter: every(_ => _.status === 'pending' && _.objectId === objectId, handleOptionalUserFilter(query.filter)),
          limit: ifDef(query.limit, Number),
        })
        await sendObjects(tasks, req, res, req.baseUrl + '/tasks')
      })
    )

    api.get(
      '/:collection/:object/actions',
      wrap((req, res) => {
        const { actions } = req.collection
        return sendObjects(actions === undefined ? [] : Array.from(Object.keys(actions), id => ({ id })), req, res)
      })
    )
    api.post('/:collection/:object/actions/:action', json(), (req, res, next) => {
      const { action } = req.params
      const fn = req.collection.actions?.[action]
      if (fn === undefined) {
        return next()
      }

      const { xapiObject, xoObject } = req
      const task = app.tasks.create({ name: `REST: ${action} ${req.collection.type}`, objectId: xoObject.id })
      const pResult = task.run(() => fn({ xapiObject, xoObject }, req.body))
      if (Object.hasOwn(req.query, 'sync')) {
        pResult.then(result => res.json(result), next)
      } else {
        pResult.catch(noop)
        res.statusCode = 202
        res.end(req.baseUrl + '/tasks/' + task.id)
      }
    })

    api.get(
      '/:collection/:object/:route',
      wrap((req, res, next) => {
        const handler = req.collection.routes?.[req.params.route]
        if (handler !== undefined) {
          return handler(req, res, next)
        }
        return next()
      })
    )

    api.post(
      '/:collection(srs)/:object/vdis',
      wrap(async (req, res) => {
        const sr = req.xapiObject
        req.length = +req.headers['content-length']

        const { name_label, name_description, raw } = req.query
        const vdiRef = await sr.$importVdi(req, {
          format: raw !== undefined ? VDI_FORMAT_RAW : VDI_FORMAT_VHD,
          name_label,
          name_description,
        })

        res.end(await sr.$xapi.getField('VDI', vdiRef, 'uuid'))
      })
    )

    api.delete(
      '/:collection(vdis|vdi-snapshots|vms|vm-snapshots|vm-templates)/:object',
      wrap(async (req, res) => {
        await req.xapiObject.$destroy()
        res.sendStatus(200)
      })
    )
  }
}
