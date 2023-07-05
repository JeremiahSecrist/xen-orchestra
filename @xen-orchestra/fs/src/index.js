import execa from 'execa'
import { parse } from 'xo-remote-parser'

import RemoteHandlerLocal from './local'
import RemoteHandlerNfs from './nfs'
import RemoteHandlerS3 from './s3'
import RemoteHandlerSmb from './smb'
import RemoteHandlerDedup from './dedupLocal'
export { DEFAULT_ENCRYPTION_ALGORITHM, UNENCRYPTED_ALGORITHM, isLegacyEncryptionAlgorithm } from './_encryptor'

const HANDLERS = {
  file: RemoteHandlerLocal,
  nfs: RemoteHandlerNfs,
  s3: RemoteHandlerS3,
}

try {
  execa.sync('mount.cifs', ['-V'])
  HANDLERS.smb = RemoteHandlerSmb
} catch (_) {}

export const getHandler = (remote, ...rest) => {
  const {type, dedup }  = parse(remote.url)
  let Handler = HANDLERS[type]
  if (!Handler) {
    throw new Error('Unhandled remote type')
  }
  if(type === 'file' && dedup === true){
    Handler = RemoteHandlerDedup
  }
  return new Handler(remote, ...rest)
}

export const getSyncedHandler = async (...opts) => {
  const handler = getHandler(...opts)
  await handler.sync()
  return {
    dispose: () => handler.forget(),
    value: handler,
  }
}
