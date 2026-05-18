import fsp from 'fs/promises'
import path from 'path'

export async function atomicWrite(filePath: string, data: string | Buffer) {
  const dir = path.dirname(filePath)
  const base = path.basename(filePath)
  const tmp = path.join(dir, `.${base}.partial`)
  // If data is a Buffer, don't pass an encoding (write raw bytes).
  if (Buffer.isBuffer(data)) {
    await fsp.writeFile(tmp, data)
  } else {
    await fsp.writeFile(tmp, data, 'utf8')
  }
  await fsp.rename(tmp, filePath)
}
