import { useEffect, useState } from 'react';

/** El valor, pero recién cuando deja de cambiar por `ms` (p. ej. al escribir una búsqueda). */
export function useDebounced(value, ms = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}
