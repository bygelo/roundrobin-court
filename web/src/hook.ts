import { useCallback, useEffect, useRef, useState } from 'react'

export type Resource<T> = {
  data: T | undefined
  error: Error | undefined
  is_loading: boolean
  reload: () => void
}

/** Load data on mount and whenever `dependency` changes. */
export function useResource<T>(loader: () => Promise<T>, dependency: unknown[] = []): Resource<T> {
  const [data, setData] = useState<T>()
  const [error, setError] = useState<Error>()
  const [is_loading, setLoading] = useState(true)
  const [version, setVersion] = useState(0)
  const loader_ref = useRef(loader)
  loader_ref.current = loader

  useEffect(() => {
    let is_current = true
    setLoading(true)
    loader_ref
      .current()
      .then((value) => {
        if (!is_current) return
        setData(value)
        setError(undefined)
      })
      .catch((caught: unknown) => {
        if (is_current) setError(caught instanceof Error ? caught : new Error(String(caught)))
      })
      .finally(() => {
        if (is_current) setLoading(false)
      })
    return () => {
      is_current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...dependency, version])

  const reload = useCallback(() => setVersion((value) => value + 1), [])
  return { data, error, is_loading, reload }
}

/** Re-run `tick` every `millisecond` while mounted — for live boards and displays. */
export function useInterval(tick: () => void, millisecond: number | undefined) {
  const tick_ref = useRef(tick)
  tick_ref.current = tick
  useEffect(() => {
    if (millisecond === undefined) return
    const handle = window.setInterval(() => tick_ref.current(), millisecond)
    return () => window.clearInterval(handle)
  }, [millisecond])
}

export type Action<A extends unknown[], T> = {
  run: (...argument: A) => Promise<T | undefined>
  is_pending: boolean
  error: Error | undefined
  clearError: () => void
}

/** Wrap a submit so a screen can show pending state and the refusal message. */
export function useAction<A extends unknown[], T>(perform: (...argument: A) => Promise<T>): Action<A, T> {
  const [is_pending, setPending] = useState(false)
  const [error, setError] = useState<Error>()
  const run = useCallback(
    async (...argument: A) => {
      setPending(true)
      setError(undefined)
      try {
        return await perform(...argument)
      } catch (caught) {
        setError(caught instanceof Error ? caught : new Error(String(caught)))
        return undefined
      } finally {
        setPending(false)
      }
    },
    [perform],
  )
  return { run, is_pending, error, clearError: () => setError(undefined) }
}
