'use strict'
const NbdClient = require('../index.js')
const { spawn, exec } = require('node:child_process')
const fs = require('node:fs/promises')
const { test } = require('tap')
const tmp = require('tmp')
const { pFromCallback } = require('promise-toolbox')
const { Socket } = require('node:net')
const { NBD_DEFAULT_PORT } = require('../constants.js')
const assert = require('node:assert')

const FILE_SIZE = 10 * 1024 * 1024

async function createTempFile(size) {
  const tmpPath = await pFromCallback(cb => tmp.file(cb))
  const data = Buffer.alloc(size, 0)
  for (let i = 0; i < size; i += 4) {
    data.writeUInt32BE(i, i)
  }
  await fs.writeFile(tmpPath, data)

  return tmpPath
}

async function spawnNbdKit(path) {
  let tries = 5
  // wait for server to be ready

  const nbdServer = spawn(
    'nbdkit',
    [
      'file',
      path,
      '--newstyle', //
      '--exit-with-parent',
      '--read-only',
      '--export-name=MY_SECRET_EXPORT',
      '--tls=on',
      '--tls-certificates=./tests/',
      //  '--tls-verify-peer',
      //  '--verbose',
      '--exit-with-parent',
    ],
    {
      stdio: ['inherit', 'inherit', 'inherit'],
    }
  )
  nbdServer.on('error', err => {
    console.error(err)
  })
  do {
    try {
      const socket = new Socket()
      await new Promise((resolve, reject) => {
        socket.connect(NBD_DEFAULT_PORT, 'localhost')
        socket.once('error', reject)
        socket.once('connect', resolve)
      })
      socket.destroy()
      break
    } catch (err) {
      tries--
      if (tries <= 0) {
        throw err
      } else {
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
    }
  } while (true)
  return nbdServer
}

async function killNbdKit() {
  return new Promise((resolve, reject) =>
    exec('pkill -9 -f -o nbdkit', err => {
      err ? reject(err) : resolve()
    })
  )
}

test('it works with unsecured network', async tap => {
  const path = await createTempFile(FILE_SIZE)

  let nbdServer = await spawnNbdKit(path)
  const client = new NbdClient(
    {
      address: '127.0.0.1',
      exportname: 'MY_SECRET_EXPORT',
      cert: `-----BEGIN CERTIFICATE-----
MIIDazCCAlOgAwIBAgIUeHpQ0IeD6BmP2zgsv3LV3J4BI/EwDQYJKoZIhvcNAQEL
BQAwRTELMAkGA1UEBhMCQVUxEzARBgNVBAgMClNvbWUtU3RhdGUxITAfBgNVBAoM
GEludGVybmV0IFdpZGdpdHMgUHR5IEx0ZDAeFw0yMzA1MTcxMzU1MzBaFw0yNDA1
MTYxMzU1MzBaMEUxCzAJBgNVBAYTAkFVMRMwEQYDVQQIDApTb21lLVN0YXRlMSEw
HwYDVQQKDBhJbnRlcm5ldCBXaWRnaXRzIFB0eSBMdGQwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQC/8wLopj/iZY6ijmpvgCJsl+zY0hQZQcIoaCs0H75u
8PPSzHedtOLURAkJeMmIS40UY/eIvHh7yZolevaSJLNT2Iolscvc2W9NCF4N1V6y
zs4pDzP+YPF7Q8ldNaQIX0bAk4PfaMSM+pLh67u+uI40732AfQqD01BNCTD/uHRB
lKnQuqQpe9UM9UzRRVejpu1r19D4dJruAm6y2SJVTeT4a1sSJixl6I1YPmt80FJh
gq9O2KRGbXp1xIjemWgW99MHg63pTgxEiULwdJOGgmqGRDzgZKJS5UUpxe/ViEO4
59I18vIkgibaRYhENgmnP3lIzTOLlUe07tbSML5RGBbBAgMBAAGjUzBRMB0GA1Ud
DgQWBBR/8+zYoL0H0LdWfULHg1LynFdSbzAfBgNVHSMEGDAWgBR/8+zYoL0H0LdW
fULHg1LynFdSbzAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQBD
OF5bTmbDEGoZ6OuQaI0vyya/T4FeaoWmh22gLeL6dEEmUVGJ1NyMTOvG9GiGJ8OM
QhD1uHJei45/bXOYIDGey2+LwLWye7T4vtRFhf8amYh0ReyP/NV4/JoR/U3pTSH6
tns7GZ4YWdwUhvOOlm17EQKVO/hP3t9mp74gcjdL4bCe5MYSheKuNACAakC1OR0U
ZakJMP9ijvQuq8spfCzrK+NbHKNHR9tEgQw+ax/t1Au4dGVtFbcoxqCrx2kTl0RP
CYu1Xn/FVPx1HoRgWc7E8wFhDcA/P3SJtfIQWHB9FzSaBflKGR4t8WCE2eE8+cTB
57ABhfYpMlZ4aHjuN1bL
-----END CERTIFICATE-----
`,
    },
    {
      readAhead: 2,
    }
  )

  await client.connect()
  tap.equal(client.exportSize, BigInt(FILE_SIZE))
  const CHUNK_SIZE = 1024 * 1024 // non default size
  const indexes = []
  for (let i = 0; i < FILE_SIZE / CHUNK_SIZE; i++) {
    indexes.push(i)
  }
  const nbdIterator = client.readBlocks(function* () {
    for (const index of indexes) {
      yield { index, size: CHUNK_SIZE }
    }
  })
  let i = 0
  for await (const block of nbdIterator) {
    let blockOk = true
    let firstFail
    for (let j = 0; j < CHUNK_SIZE; j += 4) {
      const wanted = i * CHUNK_SIZE + j
      const found = block.readUInt32BE(j)
      blockOk = blockOk && found === wanted
      if (!blockOk && firstFail === undefined) {
        firstFail = j
      }
    }
    tap.ok(blockOk, `check block ${i} content`)
    i++

    // flaky server is flaky
    if (i % 7 === 0) {
      // kill the older nbdkit process
      await killNbdKit()
      nbdServer = await spawnNbdKit(path)
    }
  }

  // we can reuse the conneciton to read other blocks
  // default iterator
  const nbdIteratorWithDefaultBlockIterator = client.readBlocks()
  let nb = 0
  for await (const block of nbdIteratorWithDefaultBlockIterator) {
    nb++
    tap.equal(block.length, 2 * 1024 * 1024)
  }

  tap.equal(nb, 5)
  assert.rejects(() => client.readBlock(100, CHUNK_SIZE))

  await client.disconnect()
  // double disconnection shouldn't pose any problem
  await client.disconnect()
  nbdServer.kill()
  await fs.unlink(path)
})
