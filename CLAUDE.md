# CLAUDE.md — Binance Spot Bot

## Objetivo

Bot de trading para **Binance Spot** en Node.js (ES modules). Proyecto de
**aprendizaje y portafolio**. Por ahora **solo opera en Spot Testnet o Demo Mode**,
y por defecto en dry-run. El usuario sabe JavaScript, React, SQL y cloud, pero tiene
poca experiencia en trading: explícale brevemente los conceptos de trading que aparezcan.

## Reglas que NUNCA se deben romper

1. **Solo testnet, demo o dry-run.**
   - La conexión a mainnet está bloqueada en tres capas: la config solo acepta
     `BINANCE_ENV=testnet|demo`, la lista blanca de hosts está en
     `src/config/safety.js`, y la guardia envuelve `exchange.fetch` y `exchange.client`.
   - Habilitar mainnet requiere una **decisión explícita del usuario**. No lo
     propongas como atajo ni lo hagas "temporalmente".
2. **Dry-run activado por defecto.** Desactivarlo exige exactamente `DRY_RUN=false`
   (`0`, `no` u `off` son un error), con advertencia y 5 s para cancelar al arrancar.
3. **Toda orden pasa por el módulo de riesgo.**
   - `OrderExecutor` es la única vía para operar.
   - `RiskManager.checkOrder()` emite aprobaciones infalsificables (WeakSet privado),
     de un solo uso, que vencen en 30 s y están atadas a la orden exacta.
   - Los venues las exigen, el filtro de red (`src/execution/order-gate.js`) bloquea
     toda petición que cree órdenes sin `clientOrderId` autorizado, y la WebSocket
     API está bloqueada.
   - Nunca agregues un camino que cree órdenes por fuera de esto.
4. **Idempotencia.**
   - El `clientOrderId` se guarda en SQLite como `pending` **antes** de enviar.
   - Ante timeout o error de red: esperar `recvWindow` + margen (6 s) y **consultar
     por `clientOrderId`**. Nunca reenviar.
   - Una señal (`signal_key`) produce como máximo una orden.
5. **El estado de riesgo persiste en SQLite** (parada, posiciones, eventos) y no se
   resetea al reiniciar. Reanudar siempre es manual (`npm run resume`).
6. **Apagar el bot no vende ni cierra posiciones abiertas.** Solo cancela órdenes
   pendientes no ejecutadas.
7. **La estrategia solo recibe velas cerradas.** Las actualizaciones de la vela en
   curso solo emiten `price`.
8. **El backtest usa los mismos módulos** de estrategia, riesgo y ejecución que el
   bot en vivo (no reimplementaciones), **sin sesgo de futuro**: señal al cierre,
   ejecución a la apertura de la vela siguiente más slippage.
9. **Los datos de distintos entornos nunca se mezclan.** Los repositorios se atan a
   un ámbito (entorno + modo) y la base de datos lo refuerza con CHECKs y triggers.
10. **Las API keys solo van en `.env`**: nunca en el código, en logs (se redactan) ni en git.
11. **El panel es de solo lectura**, escucha **solo en 127.0.0.1** y su **única
    acción** es activar el kill switch.
    - Host fijo en el código; solo el puerto se configura (`PANEL_PORT`).
    - Nunca agregues rutas que escriban: ni órdenes, ni configuración, ni reanudar.
      Las pruebas exigen que `POST /api/kill-switch` sea la única ruta que no es GET.
    - El kill switch usa `activateKillSwitch()` (la misma función que `npm run kill`)
      y exige Host, Origin exacto, Sec-Fetch-Site, JSON, `confirm: true` y el token local.
    - El panel nunca lee ni envía API keys ni secretos, nunca migra la base y nunca
      importa ccxt, ws, el cliente del exchange, la ejecución ni el feed.

## Forma de trabajo

- Mostrar el **plan** antes de programar y esperar la aprobación.
- Avanzar **un módulo a la vez** y **detenerse** al terminar cada uno para que el
  usuario lo revise. En la pausa: qué hace el módulo, cómo se cumplió cada
  requisito y los conceptos de trading nuevos.
- **Un commit por módulo, después de la aprobación del usuario**, con mensaje
  descriptivo en español y la línea `Co-Authored-By`. No hagas commit sin aprobación.
- Antes de cada commit, correr **todas** las pruebas y mostrar el resultado.
- Validar las pruebas con **mutaciones**: romper a propósito la regla y confirmar
  que alguna prueba falla. Si una mutación sobrevive, agregar la prueba que falta.
- Probar en vivo contra el testnet (endpoints públicos) cuando aplique, usando
  rutas temporales para `DB_PATH` y `KILL_SWITCH_FILE`, sin tocar `data/` del usuario.
- **Probar la interfaz del panel en el navegador integrado:**
  - Sobre una **copia** de la base (`VACUUM INTO` desde una conexión de solo lectura),
    con rutas temporales y otro puerto (8798).
  - El `launch.json` va en la carpeta de la sesión (`Desktop\Claude\.claude`), fuera del repo.
  - Revisar consola (violaciones de CSP), tema claro/oscuro, celular (375 px, sin
    desplazamiento horizontal) y estados vacíos.
- **Las keys reales del `.env` nunca se imprimen**: ni en comandos, ni en salidas, ni
  en logs. Las verificaciones leen el `.env` en memoria (scripts en la carpeta
  temporal) e informan solo sí/no, longitudes o saldos. Nunca pongas una key en la
  línea de comandos.
- **Antes de publicar o hacer push:**
  - `git check-ignore -v .env data/`;
  - `git ls-files` sin `.env`, bases de datos ni logs;
  - escaneo de TODO el historial (todas las versiones y los mensajes) buscando las
    keys del `.env` y cadenas con forma de key, sin imprimirlas;
  - después del push, confirmar en el remoto que `.env` y `data/` no están.
- Ser transparente con errores propios, límites y decisiones pendientes.

## Comandos

```bash
npm install                  # usa .npmrc (ignore-scripts=true); no requiere compilar nada
cp .env.example .env         # STRATEGY es obligatoria (el ejemplo trae sma-cross)
npm test                     # Vitest, 706 pruebas; sin red ni API keys
npm start                    # arranca el bot (dry-run por defecto)
npm run backtest -- --from 2025-01-01 --to 2025-07-01 [--split 2025-05-01] [--grid '{"fast":[5,9],"slow":[21,30]}']
npm run kill -- "motivo"     # kill switch: detiene todos los entornos y modos
npm run resume               # reanudación manual del entorno y modo del .env
npm run status               # estado de riesgo, posiciones, órdenes de hoy, eventos
npm run feed                 # monitor de datos en vivo (solo lectura)
npm run reconcile            # diferencias con el exchange (--cancel-unknown, --accept-balances)
npm run panel                # compila la interfaz y abre el panel en http://127.0.0.1:8787
npm run panel:dev            # panel + recompilación de la interfaz al guardar
npm run panel:build          # solo compila la interfaz (panel/web/dist, ignorado por git)
```

## Estado (2026-09-29)

**Terminados:**
- **Módulos 1 a 9:** base y guardia, estrategia, riesgo, almacenamiento, datos,
  ejecución, ciclo del bot, backtest y README.
- **Panel web, partes 1 a 8:** datos para el panel en el bot, servidor, estructura
  de la interfaz, estado y riesgo, gráfico, órdenes y logs, backtests y documentación.

Hay 706 pruebas pasando. Esquema SQLite en la **v5**.

**API keys del Spot Testnet:** el usuario ya las puso en su `.env`
(`BINANCE_ENV=testnet`, `DRY_RUN=true`). Se verificaron el 2026-09-29 con lecturas
firmadas (cuenta SPOT, saldo del testnet), sin imprimirlas.

Pendientes:
- **Decisión del usuario sobre la regla de pérdida diaria:** ver "Decisiones".
- **Prueba real con órdenes en el testnet:** las keys ya funcionan, pero enviar
  órdenes exige `DRY_RUN=false` y lo decide el usuario. Todo lo de ejecución está
  probado contra un Binance simulado por HTTP.
- **GitHub:** el proyecto se publica como repositorio **privado**. Antes de cada
  push, hacer la verificación de "Forma de trabajo".

## Arquitectura

Flujo: **datos → (cola del bot) → estrategia → riesgo → ejecución → almacenamiento**.

| Módulo | Qué hace |
|---|---|
| `src/config/` | `index.js` valida el `.env` con zod y devuelve config inmutable (`loadPaths()` para herramientas de emergencia). `safety.js` es la guardia de red (lista blanca exacta de hosts; hook `beforeRequest`). `preflight.js` verifica conexión, mercado y credenciales del entorno. |
| `src/data/` | `candle-feed.js`: solo velas cerradas, continuas y sin duplicados vía el caché; rellena huecos por REST y, tras reconectar, emite solo la más reciente. `kline-stream.js`: WebSocket propio con pong, rotación a las 23 h, detección de conexión zombi y backoff con jitter. `candle-fetcher.js`: REST paginado. `rate-limiter.js`: peso por cabecera, frena al 80%, 429 → `Retry-After`, 418 → detiene todo. `time-sync.js`: hora del servidor compensando RTT, cada 30 min. `data-health.js`: datos desactualizados. |
| `src/strategy/` | `base-strategy.js`: interfaz; `evaluate()` valida los datos y devuelve HOLD ante datos vacíos, insuficientes o inválidos. `registry.js`: detecta estrategias en `strategies/`; la activa se elige con `STRATEGY` (obligatoria). `indicators.js`: SMA. `strategies/sma-cross.js`. |
| `src/risk/` | `risk-manager.js`: `checkOrder()` con aprobaciones, `sizeBuy`/`sizeSell`, PnL diario, `enforceLimits()`, `emergencyStop()`, `resume()`. `market-filters.js`: paso, tick, mínimos, notional. `pnl.js`: PnL con comisiones y día UTC. `kill-switch.js`: archivo `STOP`. `kill-command.js`: `activateKillSwitch()` (archivo + `haltAll`), usada por `npm run kill` y el panel. |
| `src/execution/` | `executor.js`: única vía para operar, en cola y con idempotencia. `venues.js`: `PaperVenue` (dry-run) y `ExchangeVenue` (testnet/demo). `order-gate.js`: filtro de red. `reconciler.js`: reconciliación. `fill-model.js`: comisión y slippage, compartido con el backtest. `index.js`: armado según el modo. |
| `src/storage/` | `db.js`/`migrations.js`: SQLite con migraciones versionadas e historial en `schema_migrations`; copia de seguridad (`VACUUM INTO` a `<carpeta>/backups/`) antes de migrar una base con datos. `scope.js`: entornos `testnet`, `demo`, `production-readonly` × modos `dry-run`, `exchange`. Repositorios `risk-store`, `order-store`, `candle-store`, `balance-store`, `bot-status-store` (estado del bot para el panel; `publicSettings()` es la lista blanca de config). |
| `src/backtest/` | `engine.js`: motor con los módulos reales sobre SQLite en memoria y reloj simulado. `command.js`: datos, huecos, `--split` y `--grid`, guardado. `market-data-client.js`: `data-api.binance.vision`, solo lectura, sin keys ni ccxt. `metrics.js`, `report.js`, `results.js` (SQLite y CSV). |
| `src/app.js` | Arranque en 5 pasos: config y entorno → hora → estado de riesgo → reconciliación → velas históricas. Si uno falla lanza `StartupError` y cierra lo abierto. |
| `src/bot.js` | Cola secuencial de velas (límites → estrategia → orden → límites), heartbeat, kill switch en caliente y apagado ordenado. Guarda su estado en `bot_status` (arranque, heartbeat, cada vela, apagado); si guardar falla, solo lo advierte. |
| `src/lifecycle.js` | SIGINT/SIGTERM y errores no controlados → apagado ordenado; segundo Ctrl+C fuerza la salida. |
| `src/lib/` | `exchange.js` (único lugar que crea el cliente ccxt con keys: guardia + filtro de órdenes + limitador), `logger.js` (con `scope` agrega `"scope":"env/mode"` a cada línea), `backoff.js`, `candles.js`, `ids.js`, `timeframes.js`. |
| `panel/server/` | Servidor del panel (proceso aparte): `index.js` (arranque, 127.0.0.1, token, `instanceId`), `app.js` (`ROUTES`: todo GET + `POST /api/kill-switch`), `security.js` (Host, métodos, Origin, token, CSP), `config.js` (lista blanca sin secretos; valida `PANEL_PORT`), `database.js` (SQLite `readonly` + `query_only`; informa base inexistente o de otra versión), `live.js` (SSE: `data_version`, STOP, log), `log-reader.js` (filtro y redacción), `queries/` (estado, riesgo con el `RiskManager` real, velas con `strategy.evaluate()`, órdenes, backtests con `buyAndHold()`). |
| `panel/web/` | Interfaz React + Vite, compilada a `dist/` y servida por el servidor del panel. `src/lib/`: lógica pura y probada (formatos, API, textos, vistas de estado/riesgo/gráfico/órdenes/logs/backtests). `src/sections/`: una por sección. `src/components/`: UI, gráficos (lightweight-charts), diálogo y kill switch. `src/hooks/`: SSE (`live.jsx`), `useApi` (datos atados a su URL: nunca se mezclan ámbitos), tema, reloj. |

## Decisiones tomadas

**Entornos y dependencias**
- **Entornos:** Spot Testnet (`testnet.binance.vision`) por defecto y Demo Mode
  (`demo-api.binance.com`) como opción. El backtest usa datos públicos de producción
  en solo lectura (`data-api.binance.vision`, entorno `production-readonly`).
- **ccxt 4.5** en lugar de `@binance/spot`: filtros del par ya interpretados,
  limitador, `setSandboxMode` y `enableDemoTrading`.
- **Cliente WebSocket propio** (paquete `ws`): `watchOHLCV` de ccxt descarta el campo
  `x` (vela cerrada).
- **better-sqlite3** (síncrono) con **`.npmrc` `ignore-scripts=true`**: al instalar
  desde el lockfile, npm intentaba compilarlo con node-gyp y fallaba sin Visual Studio.
- **Logs:** pino. En consola escribe por `process.stdout` y no al descriptor 1,
  porque en Windows eso rompe los acentos.
- **Pruebas:** Vitest. Binance se simula por HTTP (`test/support/fake-binance.js`) a
  través del cliente ccxt real, y el WebSocket con `test/support/fake-socket.js`.

**Dinero y riesgo**
- **Dinero en USDT** (`SYMBOL` debe ser `BASE/USDT`) y **día en UTC** (00:00:00 a
  23:59:59.999 UTC) para la pérdida diaria.
- **Regla de pérdida diaria vigente:**
  - Se mide el PnL **neto** del día UTC = realizado (con comisiones de compra y
    venta) + no realizado de las posiciones abiertas **desde su entrada**, aunque sea
    de otro día, menos la comisión estimada de venta.
  - Si llega a `≤ −MAX_DAILY_LOSS_USDT`, hay parada de emergencia: guarda la parada
    → bloquea **toda** orden, **incluidas las ventas** → cancela las pendientes →
    registra el motivo → detiene.
  - `resume` se niega el mismo día UTC si la pérdida realizada sigue en el límite.
  - **Consecuencia conocida:** una posición perdedora puede quedar atrapada (el
    backtest lo reproduce).
  - Alternativas propuestas **sin decidir por el usuario**: (a) permitir durante la
    parada solo las ventas que reducen la posición; (b) medir desde el capital al
    inicio del día UTC. **No cambies la regla sin su decisión.**
- **Dust:** el residuo sin vender por el paso del par se cuenta como pérdida. Una
  venta parcial divide la posición.
- **`MAX_TRADE_USDT`** incluye comisión y slippage estimados y aplica solo a compras.
  Las ventas no se limitan por monto.
- **Kill switch:** `npm run kill` detiene **todos** los ámbitos y funciona con la
  config rota. El panel usa la misma función (`activateKillSwitch`). `resume` reanuda
  **solo** el ámbito del `.env`, y únicamente desde la terminal.

**Ejecución**
- Órdenes de **mercado** únicamente.
- Una orden que no llegó tras un timeout queda `rejected`, con `reject_source=exchange`
  y código `NOT_CREATED`.
- **Reconciliación al arrancar:** resuelve órdenes pendientes, detecta órdenes
  desconocidas en Binance y saldos que no cuadran (foto de referencia + ejecuciones).
  Si hay diferencias, no se opera.

**Datos y ciclo**
- **Datos desactualizados:** sin señales de vida (mensajes, pings o REST) por
  `DATA_STALE_AFTER_SECONDS`, o falta la primera vela cerrada esperada, o se están
  rellenando huecos → se bloquean las órdenes.
- **Señales tardías:** una vela que cerró hace más de `DATA_STALE_AFTER_SECONDS` no
  se opera. Tres errores seguidos procesando velas → apagado seguro.

**Backtest**
- Capital por defecto de 20 USDT. Presupuesto por compra = `min(MAX_TRADE_USDT, saldo)`.
- Con huecos no corre sin `--allow-gaps`.
- `--grid` elige la combinación de mayor PnL neto **solo** en el período de ajuste y
  valida únicamente esa.
- La pérdida diaria se reanuda de forma simulada a las 00:00 UTC.
- IDs deterministas: los resultados son reproducibles.
- La curva de capital se guarda en `backtest_equity`. Punto 0: capital inicial al
  inicio del período; punto n ≥ 1: valor al cierre de la vela que empieza en `time`.
  Los resultados anteriores a la v5 no la tienen: el panel dibuja una curva por
  operación (escalonada) y sugiere volver a correrlos.

**Migraciones**
- Nunca edites una migración ya publicada: agrega una nueva al final.
- Una migración nueva solo **agrega** tablas o columnas, salvo decisión explícita del
  usuario. Hay una prueba que lo verifica para la v5 (SQL sin DROP/UPDATE/DELETE, y
  esquema y datos existentes idénticos).
- `openDatabase()` hace una copia con `VACUUM INTO` antes de migrar una base con
  datos (`<carpeta de la base>/backups/<nombre>.v<N>.<fecha>.db`). Si la copia falla,
  no migra.

**Panel**
- **Proceso separado del bot**, en Express. Lee SQLite en solo lectura (WAL: no bloquea
  al bot). El bot no sabe que el panel existe; si el panel falla, el bot sigue.
- **Estado del bot en `bot_status`** (una fila por ámbito), escrito por el bot al
  arrancar, en cada heartbeat, tras cada vela y al apagarse. Si pasan más de
  2 intervalos + 10 s sin heartbeat, el estado es "sin responder".
  - Las horas del bot son del reloj de Binance y el panel usa el de la PC: las edades
    negativas se muestran como 0.
- **Tiempo real por SSE:** `PRAGMA data_version` (cambios de otros procesos), el
  archivo STOP y las líneas nuevas del log. Solo se vigila con alguien conectado.
- **Seguridad:**
  - Host permitido: solo `127.0.0.1:PUERTO` y `localhost:PUERTO` (anti DNS rebinding).
  - Todo lo que no sea GET/HEAD recibe 405, salvo la única ruta POST. Sin CORS.
  - CSP estricta: `script-src 'self'` y `style-src 'self'`, sin estilos ni scripts
    en línea; `frame-ancestors 'none'`.
  - Token de 32 bytes por ejecución, solo dentro del HTML. `instanceId` público en
    `/api/meta` y en el saludo SSE: si cambia, la página pide recargar.
- **Config del panel:** lee el `.env` con `dotenv.parse` y una lista blanca
  (`PANEL_ENV_KEYS`), validada con `publicEnvShape` del bot. Un valor inválido usa el
  defecto y avisa. `PANEL_PORT` lo valida el panel, no el esquema del bot.
- **Datos que no se recalculan aparte:**
  - el PnL con `RiskManager.dailyPnl()`;
  - las medias del gráfico con `strategy.evaluate()` sobre la misma ventana que el bot;
  - comprar y mantener con `buyAndHold()` vela a vela.
- **Interfaz:**
  - React + Vite compilada y servida SIEMPRE por el servidor del panel. No se usa el
    servidor de desarrollo de Vite: obligaba a relajar la CSP y exponía `/@fs/`.
  - `panel:dev` recompila al guardar.
- **lightweight-charts (Apache 2.0):**
  - Su logo inserta un `<style>` que la CSP bloquea. Por eso está desactivado y hay
    un enlace propio a tradingview.com bajo cada gráfico, más el aviso del NOTICE en
    `CandleChart.jsx` y en el README; una prueba lo exige.
  - La rueda del mouse no hace zoom: desplaza la página.
- **Logs:** las líneas del bot, `resume` y `reconcile` llevan `"scope":"env/mode"`.
  Se llama `scope` porque el heartbeat ya registra `env` y `mode`, y pino
  duplicaría las claves. El navegador filtra las líneas en vivo con la misma regla
  que el servidor; una prueba compara los dos filtros.

## Convenciones

- **Todo en español:** comentarios, mensajes de log, errores, pruebas y commits.
  JSDoc en las funciones públicas.
- **Errores de rechazo esperado** (`SafetyError`, `PreflightError`, `StrategyError`,
  `RiskError`, `ConfigError`) se muestran sin stack trace. Los inesperados, completos.
- **Pruebas de backtest:** con resultados calculados a mano y los cálculos en comentarios.
- **Interfaz del panel:**
  - La lógica va en `panel/web/src/lib/` como funciones puras con pruebas; los
    componentes solo la muestran.
  - Colores como variables CSS (tema claro/oscuro) y nada cargado de otros sitios.
  - Todo texto en español.
  - Fechas `AAAA-MM-DD HH:MM:SS` (24 h) y números con la configuración regional del navegador.

## Entorno de desarrollo

- **Sistema:** Windows 11, PowerShell y Git Bash; Node 24 (Volta).
- **Terminal:** en Git Bash, `node -e` con scripts de varias líneas a veces no
  ejecuta nada; usa archivos de script. Para editar JSON (p. ej. `package.json`), usa
  el editor y no `node -e`.
- **Señales en Windows:** no se puede enviar SIGINT/SIGTERM "amable" desde otro
  proceso (Node lo convierte en un cierre forzado). El apagado se prueba con pruebas
  unitarias sobre un `process` simulado y en vivo con `npm run kill`.
