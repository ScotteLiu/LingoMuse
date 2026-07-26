function cancelledError() {
  const error = new Error('operation_cancelled')
  error.code = 'CANCELLED'
  return error
}

export function createSerialTaskQueue() {
  let active = null
  const pending = []
  const idleWaiters = []

  function settleIdleWaiters() {
    if (active || pending.length) return
    while (idleWaiters.length) idleWaiters.shift()()
  }

  function pump() {
    if (active || pending.length === 0) return
    active = pending.shift()
    Promise.resolve()
      .then(() => active.task(active.controller.signal))
      .then(active.resolve, active.reject)
      .finally(() => {
        active = null
        pump()
        settleIdleWaiters()
      })
  }

  function cancel(key) {
    if (active?.key === key) active.controller.abort(cancelledError())
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      if (pending[index].key !== key) continue
      const [item] = pending.splice(index, 1)
      item.reject(cancelledError())
    }
  }

  return {
    run(key, task) {
      cancel(key)
      return new Promise((resolve, reject) => {
        pending.push({ key, task, resolve, reject, controller: new AbortController() })
        pump()
      })
    },
    cancel,
    cancelAll() {
      if (active) active.controller.abort(cancelledError())
      while (pending.length) pending.shift().reject(cancelledError())
    },
    whenIdle() {
      if (!active && pending.length === 0) return Promise.resolve()
      return new Promise((resolve) => idleWaiters.push(resolve))
    },
    get size() {
      return pending.length + (active ? 1 : 0)
    },
  }
}
