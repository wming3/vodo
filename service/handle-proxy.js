import { request as requestHTTP } from 'http'
import { request as requestHTTPS } from 'https'
import { createGzip, createGunzip, constants, Z_SYNC_FLUSH } from 'zlib'
import { PassThrough } from 'stream'
import { createWriteStream } from 'fs'
import { parse } from 'url'

function restoreHeaders (headers, rawHeaders) {
  const outHeaders = {}
  rawHeaders.forEach((key, i) => {
    if (i % 2 === 0) {
      const lKey = key.toLowerCase()
      if (headers.hasOwnProperty(lKey)) {
        outHeaders[key] = headers[lKey]
      }
    }
  })
  return outHeaders
}

export const handleProxy = (req, res) => {
  IPC.request('request-id')
  .then(({ requestID, cycleID }) => {
    const clientAllowGzip = /gzip/.test(req.headers['accept-encoding'] || '')
    req.headers['accept-encoding'] = 'gzip'
    const options = Object.assign({}, parse(req.url))
    options.headers = restoreHeaders(req.headers, req.rawHeaders)
    options.method = req.method
    const request = options.protocol === 'https:'
      ? requestHTTPS
      : requestHTTP
    options.requestID = requestID
    writeUserData(`req-${cycleID}.json`, JSON.stringify(options))
    IPC.emit('caught-request-begin', {
      requestID,
      cycleID,
      hostname: options.hostname,
      method: options.method,
      pathname: options.pathname
    })
    console.info(requestID, cycleID, options.method, options.protocol, options.hostname, options.pathname.substr(0, 50))
    const proxyReq = request(options, proxyRes => {
      let decodedRes = proxyRes
      let encodedRes = proxyRes
      if (proxyRes.headers['content-encoding'] === 'gzip') {
        decodedRes = createGunzip()
        decodedRes.on('error', err => console.error(err.stack) || decodedRes.end())
        proxyRes.pipe(decodedRes)
        if (!clientAllowGzip) {
          encodedRes = decodedRes
          proxyRes.headers['content-encoding'] = 'identity'
        }
      } else if (clientAllowGzip) {
        const contentType = proxyRes.headers['content-type']
        let wrapGzip = true
        if (contentType) {
          if (/image|audio|video/.test(contentType)) {
            wrapGzip = false
          } else if (contentType !== 'application/json' && /application/.test(contentType)) {
            wrapGzip = false
          }
        }
        if (wrapGzip) {
          proxyRes.headers['content-encoding'] = 'gzip'
          proxyRes.rawHeaders.push('Content-Encoding')
          proxyRes.rawHeaders.push('gzip')
          if (proxyRes.headers['content-length']) {
            delete proxyRes.headers['content-length']
            encodedRes = createGzip()
          } else {
            encodedRes = createGzip({ flush: Z_SYNC_FLUSH || constants.Z_SYNC_FLUSH })
          }
          encodedRes.on('error', err => console.error(err.stack) || encodedRes.end())
          proxyRes.pipe(encodedRes)
        }
      }
      const outHeaders = restoreHeaders(proxyRes.headers, proxyRes.rawHeaders)
      const responseEventSent = new Promise(resolve => {
        writeUserData(`res-${cycleID}.json`, JSON.stringify({
          requestID,
          statusCode: proxyRes.statusCode,
          headers: outHeaders
        }), () => {
          IPC.emit('caught-request-respond', requestID)
          resolve()
        })
      })
      res.writeHead(proxyRes.statusCode, outHeaders)
      res.headWritten = true
      const resultBodyStream = createWriteStream(userDir(`res-${cycleID}.dat`))
      proxyReq.on('error', () => resultBodyStream.end())
      resultBodyStream.on('error', () => null)
      encodedRes.pipe(res)
      decodedRes.pipe(resultBodyStream)
      let size = 0
      let maybeJSON = false
      let lastChunk
      decodedRes.on('data', chunk => {
        if (size === 0) {
          if (/^\s*[\{\[]/.test(chunk.toString())) {
            maybeJSON = true
          }
        }
        size += chunk.length
        lastChunk = chunk
      })
      resultBodyStream.on('finish', () => {
        if (maybeJSON) {
          maybeJSON = !!/[\}\]]\s*$/.test(lastChunk.toString())
        }
        writeUserData(`fin-${cycleID}.json`, JSON.stringify({
          requestID,
          size,
          maybeJSON
        }), () => {
          responseEventSent.then(() => {
            IPC.emit('caught-request-finish', requestID, size, maybeJSON)
          })
        })
      })
    })
    req.pipe(createWriteStream(userDir(`req-${cycleID}.dat`)))
    req.pipe(proxyReq)
    req.on('error', err => {
      proxyReq.end()
      IPC.emit('caught-request-error', requestID, err.message)
    })
    proxyReq.on('error', err => {
      IPC.emit('caught-request-error', requestID, err.message)
      if (!res.headWritten) {
        res.writeHead(502)
        res.end(JSON.stringify({
          error: 'target server failed',
          code: 502,
          message: err.message
        }, false, '  '))
      } else {
        res.end('')
      }
    })
  })
}

