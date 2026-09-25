/**
 * electron-builder afterPack hook: bundle the ffmpeg binary that matches the
 * TARGET platform/arch, not the build machine.
 *
 * `npm install` only fetches ffmpeg-static's binary for the host (e.g. a
 * macOS arm64 `ffmpeg`), so without this every cross-built package — the
 * Windows .exe, the Intel DMG — would ship an executable its OS can't run and
 * exports would fail. Binaries come from the same ffmpeg-static release the
 * installed package pins, cached in build/.cache between runs.
 */

'use strict'

const { mkdir, readFile, writeFile, rm, chmod, access, copyFile } = require('fs/promises')
const { join } = require('path')
const { gunzipSync } = require('zlib')

const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'arm', 3: 'arm64' }

async function exists(p) {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`ffmpeg download failed (${res.status}): ${url}`)
  return Buffer.from(await res.arrayBuffer())
}

/** Cached ffmpeg for platform-arch: { bin, license, readme } file paths. */
async function ensureFfmpeg(projectDir, platform, arch) {
  const pkg = require(join(projectDir, 'node_modules', 'ffmpeg-static', 'package.json'))
  const release = process.env.FFMPEG_BINARY_RELEASE || pkg['ffmpeg-static']['binary-release-tag']
  const base = `https://github.com/eugeneware/ffmpeg-static/releases/download/${release}`
  const dir = join(projectDir, 'build', '.cache', 'ffmpeg', release, `${platform}-${arch}`)
  const bin = join(dir, platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  const license = join(dir, 'ffmpeg.LICENSE')
  const readme = join(dir, 'ffmpeg.README')
  if (!(await exists(bin))) {
    await mkdir(dir, { recursive: true })
    console.log(`  • ffmpeg  downloading ${release} ${platform}-${arch}`)
    const gz = await download(`${base}/ffmpeg-${platform}-${arch}.gz`)
    await writeFile(bin, gunzipSync(gz))
    await chmod(bin, 0o755)
    await writeFile(license, await download(`${base}/${platform}-${arch}.LICENSE`))
    await writeFile(readme, await download(`${base}/${platform}-${arch}.README`))
  }
  return { bin, license, readme }
}

module.exports = async function afterPack(context) {
  const platform = context.electronPlatformName // 'darwin' | 'win32' | 'linux'
  const arch = ARCH_NAMES[context.arch]
  if (!arch) throw new Error(`ffmpeg hook: unsupported arch ${context.arch} (universal builds need lipo)`)
  const projectDir = context.packager.projectDir
  const resources =
    platform === 'darwin'
      ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : join(context.appOutDir, 'resources')
  const target = join(resources, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static')
  if (!(await exists(target))) throw new Error(`ffmpeg hook: ${target} missing — is ffmpeg-static asarUnpacked?`)

  const src = await ensureFfmpeg(projectDir, platform, arch)
  // Drop the host binary, install the target's (ffmpeg-static's index.js
  // resolves ffmpeg.exe on win32, ffmpeg elsewhere).
  await rm(join(target, 'ffmpeg'), { force: true })
  await rm(join(target, 'ffmpeg.exe'), { force: true })
  const destBin = join(target, platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  await copyFile(src.bin, destBin)
  await chmod(destBin, 0o755)
  await copyFile(src.license, join(target, 'ffmpeg.LICENSE'))
  await copyFile(src.readme, join(target, 'ffmpeg.README'))
  const size = (await readFile(destBin)).length
  console.log(`  • ffmpeg  bundled ${platform}-${arch} (${(size / 1e6).toFixed(1)} MB)`)
}
