import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const OFFLINE_PORT = 11435
export const OFFLINE_BASE_URL = `http://127.0.0.1:${OFFLINE_PORT}`
export const OFFLINE_MODEL = 'qwen3:1.7b'

let engineProcess = null
let engineBundleRoot = ''

function stopBundledProcesses(bundleRoot) {
  if (process.platform !== 'win32' || !bundleRoot) return
  const script = `
    $root = [IO.Path]::GetFullPath($env:LINGOMUSE_BUNDLE_ROOT).TrimEnd('\\') + '\\'
    Get-CimInstance Win32_Process |
      Where-Object {
        ($_.Name -eq 'ollama.exe' -or $_.Name -eq 'llama-server.exe') -and
        $_.ExecutablePath -and
        [IO.Path]::GetFullPath($_.ExecutablePath).StartsWith($root, [StringComparison]::OrdinalIgnoreCase)
      } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  `
  try {
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 3_000,
      env: { ...process.env, LINGOMUSE_BUNDLE_ROOT: resolve(bundleRoot) },
    })
  } catch {
    // A worker may have already exited on its own.
  }
}

export async function stopBundledProcessesAsync(bundleRoot, {
  signal,
  timeoutMs = 3_000,
  exitGraceMs = 500,
  spawnProcess = spawn,
  platform = process.platform,
} = {}) {
  if (platform !== 'win32' || !bundleRoot) return true
  if (signal?.aborted) return false
  const script = `
    $root = [IO.Path]::GetFullPath($env:LINGOMUSE_BUNDLE_ROOT).TrimEnd('\\') + '\\'
    Get-CimInstance Win32_Process |
      Where-Object {
        ($_.Name -eq 'ollama.exe' -or $_.Name -eq 'llama-server.exe') -and
        $_.ExecutablePath -and
        [IO.Path]::GetFullPath($_.ExecutablePath).StartsWith($root, [StringComparison]::OrdinalIgnoreCase)
      } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  `
  return new Promise((resolveDone) => {
    let child
    let settled = false
    let timeoutTimer = null
    let exitGraceTimer = null

    const finish = (confirmedExited) => {
      if (settled) return
      settled = true
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (exitGraceTimer) clearTimeout(exitGraceTimer)
      signal?.removeEventListener('abort', requestStop)
      child?.removeListener?.('error', handleError)
      child?.removeListener?.('exit', handleExit)
      child?.removeListener?.('close', handleExit)
      resolveDone(confirmedExited)
    }

    const handleExit = () => finish(true)
    const handleError = () => finish(false)
    const requestStop = () => {
      if (settled) return
      if (timeoutTimer) {
        clearTimeout(timeoutTimer)
        timeoutTimer = null
      }
      try {
        child?.kill()
      } catch {
        finish(false)
        return
      }
      // child.kill() requests termination but does not prove that Windows has
      // stopped the process. Do not let a late cleanup script race a new engine.
      if (settled) return
      exitGraceTimer = setTimeout(
        () => finish(false),
        Math.max(10, Number(exitGraceMs) || 500),
      )
    }

    try {
      child = spawnProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        stdio: 'ignore',
        env: { ...process.env, LINGOMUSE_BUNDLE_ROOT: resolve(bundleRoot) },
      })
      child.once('error', handleError)
      child.once('exit', handleExit)
      child.once('close', handleExit)
      signal?.addEventListener('abort', requestStop, { once: true })
      if (signal?.aborted) requestStop()
      else {
        timeoutTimer = setTimeout(
          requestStop,
          Math.max(1, Number(timeoutMs) || 3_000),
        )
      }
    } catch {
      finish(false)
    }
  })
}

export function containsOfflineModel(models, wanted = OFFLINE_MODEL) {
  if (!Array.isArray(models)) return false
  const normalizedWanted = String(wanted).toLowerCase()
  return models.some((item) => {
    const name = String(item?.name || item?.model || '').toLowerCase()
    return name === normalizedWanted || name === `${normalizedWanted}:latest`
  })
}

function boundedSignal(timeoutMs, signal) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
}

async function readEngineTags({ signal, timeoutMs = 900 } = {}) {
  try {
    const response = await fetch(`${OFFLINE_BASE_URL}/api/tags`, {
      signal: boundedSignal(timeoutMs, signal),
    })
    if (!response.ok) return { online: false, models: [] }
    const payload = await response.json().catch(() => ({}))
    return { online: true, models: Array.isArray(payload.models) ? payload.models : [] }
  } catch {
    return { online: false, models: [] }
  }
}

export function getOfflineBundle(resourcesPath, { allowOverride = true } = {}) {
  const overrideRoot = allowOverride ? process.env.LINGOMUSE_OFFLINE_RUNTIME : ''
  const root = overrideRoot ? resolve(overrideRoot) : join(resourcesPath, 'offline')
  const enginePath = join(root, 'ollama', 'ollama.exe')
  const modelsPath = join(root, 'models')
  return {
    available: existsSync(enginePath) && existsSync(modelsPath),
    root,
    enginePath,
    modelsPath,
  }
}

export async function startOfflineEngine(bundle, {
  timeoutMs = 25_000,
  spawnProcess = spawn,
  cleanupProcesses = stopBundledProcessesAsync,
  signal,
} = {}) {
  if (signal?.aborted) return { ok: false, error: 'ENGINE_START_CANCELLED' }
  if (!bundle.available) return { ok: false, error: 'OFFLINE_BUNDLE_MISSING' }
  let cleanupConfirmed = false
  try {
    cleanupConfirmed = await cleanupProcesses(bundle.root, { signal })
  } catch {
    cleanupConfirmed = false
  }
  if (signal?.aborted) return { ok: false, error: 'ENGINE_START_CANCELLED' }
  if (!cleanupConfirmed) return { ok: false, error: 'ENGINE_CLEANUP_TIMEOUT' }
  const existingEngine = await readEngineTags({ signal })
  if (signal?.aborted) return { ok: false, error: 'ENGINE_START_CANCELLED' }
  if (existingEngine.online) {
    return { ok: false, error: 'OFFLINE_PORT_IN_USE' }
  }

  let spawnError = ''
  try {
    engineProcess = spawnProcess(bundle.enginePath, ['serve'], {
      cwd: dirname(bundle.enginePath),
      windowsHide: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        OLLAMA_HOST: `127.0.0.1:${OFFLINE_PORT}`,
        OLLAMA_MODELS: bundle.modelsPath,
        OLLAMA_KEEP_ALIVE: '24h',
        OLLAMA_CONTEXT_LENGTH: '8192',
        OLLAMA_NUM_PARALLEL: '1',
      },
    })
    engineProcess.once('error', (error) => {
      spawnError = String(error?.message || error)
    })
    engineBundleRoot = bundle.root
    engineProcess.unref()
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  }

  const startedAt = Date.now()
  let engineBecameOnline = false
  const failStartedEngine = (error) => {
    stopOfflineEngine()
    return { ok: false, error }
  }
  while (Date.now() - startedAt < timeoutMs) {
    if (signal?.aborted) {
      stopOfflineEngine()
      return { ok: false, error: 'ENGINE_START_CANCELLED' }
    }
    if (spawnError) return failStartedEngine(`ENGINE_SPAWN_ERROR: ${spawnError}`)
    const status = await readEngineTags({ signal })
    if (status.online) {
      engineBecameOnline = true
      if (containsOfflineModel(status.models)) return { ok: true, reused: false }
    }
    if (engineProcess?.exitCode !== null) {
      return failStartedEngine(`ENGINE_EXITED_${engineProcess?.exitCode}`)
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
  }
  return failStartedEngine(engineBecameOnline ? 'OFFLINE_MODEL_MISSING' : 'ENGINE_START_TIMEOUT')
}

export async function warmOfflineModel({
  timeoutMs = 45_000,
  keepAlive = -1,
  numCtx = 8192,
  numThread,
  signal,
} = {}) {
  const startedAt = Date.now()
  try {
    const response = await fetch(`${OFFLINE_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OFFLINE_MODEL,
        prompt: '',
        stream: false,
        keep_alive: keepAlive,
        options: {
          num_ctx: numCtx,
          ...(Number.isFinite(numThread) ? { num_thread: Math.max(1, Math.round(numThread)) } : {}),
        },
      }),
      signal: boundedSignal(timeoutMs, signal),
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) return { ok: false, error: payload?.error || `WARMUP_${response.status}` }
    return {
      ok: true,
      elapsedMs: Date.now() - startedAt,
      loadDurationNs: payload?.load_duration || 0,
    }
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  }
}

export async function unloadOfflineModel({ timeoutMs = 10_000, signal } = {}) {
  try {
    const response = await fetch(`${OFFLINE_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OFFLINE_MODEL,
        prompt: '',
        stream: false,
        keep_alive: 0,
      }),
      signal: boundedSignal(timeoutMs, signal),
    })
    const payload = await response.json().catch(() => ({}))
    return response.ok
      ? { ok: true }
      : { ok: false, error: payload?.error || `UNLOAD_${response.status}` }
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  }
}

export async function isEngineOnline() {
  return (await readEngineTags()).online
}

export function stopOfflineEngine() {
  if (engineProcess && !engineProcess.killed) {
    const pid = engineProcess.pid
    try {
      if (process.platform === 'win32' && pid) {
        spawnSync('taskkill.exe', ['/pid', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
          timeout: 3_000,
        })
      } else {
        engineProcess.kill()
      }
    } catch {
      // The bundled engine may already be closed by Windows.
    }
  }
  stopBundledProcesses(engineBundleRoot)
  engineProcess = null
  engineBundleRoot = ''
}
