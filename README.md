# Binance Spot Bot (testnet)

Bot de trading educativo para **Binance Spot**, escrito en Node.js (ES modules).
Funciona **solo** contra entornos sin dinero real — [Spot Testnet](https://testnet.binance.vision)
o [Demo Mode](https://demo.binance.com) — y se niega a arrancar con cualquier otra configuración.

> ⚠️ Proyecto de aprendizaje y portafolio. No es asesoría financiera ni está pensado para operar dinero real.

> 🚧 En construcción. Este README se completa en el último módulo (instalación, API keys, backtest).

## Comandos

| Comando | Qué hace |
|---|---|
| `npm start` | Arranca el bot (dry-run por defecto) |
| `npm run kill -- "motivo"` | Kill switch: detiene el bot de forma segura |
| `npm run resume` | Reanuda después de una parada (acción manual obligatoria) |
| `npm run status` | Muestra el estado de riesgo: parada, PnL del día, posiciones |
| `npm run feed` | Monitor de datos de mercado (solo lectura): velas cerradas, precio, estado |
| `npm run reconcile` | Compara órdenes y saldos con Binance y ayuda a resolver diferencias |
| `npm run backtest -- --from AAAA-MM-DD --to AAAA-MM-DD` | Backtest con velas históricas de producción (solo lectura) |
| `npm test` | Ejecuta las pruebas |

## Gestión de riesgo

Toda orden pasa por el gestor de riesgo **antes** de enviarse. Si alguna regla
no se cumple, la orden se rechaza con un código y un motivo en el log.

### Límites que se validan antes de cada orden

| Regla | Configuración | Aplica a |
|---|---|---|
| Bot detenido o kill switch activo | — | compras y ventas |
| Reconciliación con el exchange pendiente o con diferencias | — | compras y ventas |
| Señal que ya generó una orden, u otra orden del par sin terminar | — | compras y ventas |
| Datos de mercado desactualizados | `DATA_STALE_AFTER_SECONDS` (60) | compras y ventas |
| Pérdida máxima diaria | `MAX_DAILY_LOSS_USDT` (20) | compras y ventas |
| Monto máximo por operación | `MAX_TRADE_USDT` (50) | compras |
| Máximo de posiciones abiertas | `MAX_OPEN_POSITIONS` (1) | compras |
| Solo vender lo que se tiene (Spot) | — | ventas |
| Filtros del par en Binance | los lee del exchange | compras y ventas |

- **Monto máximo por operación:** el costo *estimado* de la compra, incluyendo
  slippage (`SLIPPAGE_BPS`) y comisión (`FEE_RATE`), no puede superar
  `MAX_TRADE_USDT`. Las ventas no se limitan: cerrar una posición reduce el riesgo.
- **Filtros del par:** cantidad múltiplo del paso (`LOT_SIZE`, p. ej. 0.00001 BTC),
  precio múltiplo del tick (`PRICE_FILTER`, p. ej. 0.01 USDT), cantidades mín./máx.
  (incluido `MARKET_LOT_SIZE` para órdenes de mercado) y valor mínimo de la orden
  (`NOTIONAL`, p. ej. 5 USDT). Al arrancar, el bot verifica que `MAX_TRADE_USDT`
  alcance para una orden válida.

### Pérdida máxima diaria

**El "día" es el día UTC:** va de las **00:00:00.000 a las 23:59:59.999 UTC**, sin
importar la zona horaria de tu computador. Por ejemplo, en UTC−3 el día del bot
empieza a las 21:00 hora local. Se eligió UTC porque es la hora de Binance y no
cambia con el horario de verano.

La pérdida del día se calcula **neta y con comisiones**:

```
PnL del día = PnL realizado  (operaciones cerradas hoy UTC, comisión de compra y de venta incluidas)
            + PnL no realizado (posiciones abiertas a precio de mercado, menos la comisión estimada de venta)
```

- Las ganancias del día compensan las pérdidas.
- Una posición abierta cuenta desde su precio de entrada, aunque se haya abierto
  el día anterior (es conservador).
- Si al vender queda un residuo que no se puede vender por el paso del par
  ("dust"), su costo se cuenta como pérdida (también conservador).
- Si `PnL del día ≤ −MAX_DAILY_LOSS_USDT`, el bot ejecuta la **parada de emergencia**.

### Kill switch

`npm run kill -- "motivo"` crea el archivo `STOP` (configurable con `KILL_SWITCH_FILE`)
y registra la parada en la base de datos para **todos** los entornos y modos.
También sirve crear el archivo a mano. El bot lo revisa cada segundo.
`npm run kill` funciona aunque la configuración tenga errores: es una
herramienta de emergencia.

### Parada de emergencia

Se activa por el kill switch o por la pérdida máxima diaria, en este orden:

1. **Guarda la parada en SQLite** antes que nada: si algo falla después (o el
   proceso muere), al reiniciar el bot sigue detenido.
2. **Bloquea órdenes nuevas** (compras y ventas).
3. **Cancela las órdenes abiertas pendientes.** Si no puede, lo registra para que
   las revises manualmente.
4. **Registra el motivo** en el log (nivel `error`) y en la bitácora de eventos.
5. **Detiene el bot.**

La posición abierta, si la hay, **no se vende automáticamente**: vender sería una
orden nueva. Queda registrada para que decidas qué hacer.

### Reanudar (acción manual)

El bot **nunca se reanuda solo**, ni siquiera al empezar un nuevo día UTC:

```bash
npm run status    # revisa por qué se detuvo
npm run resume    # borra la parada y el archivo STOP
npm start
```

Si la parada fue por pérdida máxima, `npm run resume` se niega mientras la pérdida
realizada del día UTC siga en el límite, e indica desde cuándo se puede reanudar
(00:00 UTC del día siguiente).

`npm run resume` reanuda **solo el entorno y modo configurados** en el `.env`.
Si el kill switch detuvo todo y luego cambias de entorno (p. ej. de `dry-run` a
enviar órdenes al testnet), ese otro entorno también requiere su propio `resume`.

### Persistencia

El estado de riesgo vive en SQLite (`DB_PATH`, por defecto `data/bot.db`):
la parada, las posiciones (con sus comisiones) y una bitácora de eventos.
**Reiniciar el bot no resetea nada**: la pérdida acumulada del día, las posiciones
abiertas y la parada se recuperan al arrancar. Cada entorno y modo tiene su
propio estado (ver [Almacenamiento](#almacenamiento)).

## Almacenamiento

Todo se guarda en SQLite (`DB_PATH`). El esquema se crea y actualiza con
**migraciones versionadas** ([src/storage/migrations.js](src/storage/migrations.js)):
cada una se aplica una sola vez, en su propia transacción, y queda registrada en
la tabla `schema_migrations`. `npm run status` muestra la versión actual.

### Entornos: los datos nunca se mezclan

Cada registro indica su **entorno** y, si es de trading, su **modo**:

| Entorno | Qué es | Qué se guarda |
|---|---|---|
| `testnet` | Spot Testnet | órdenes, ejecuciones, posiciones, riesgo, eventos, velas |
| `demo` | Demo Mode | órdenes, ejecuciones, posiciones, riesgo, eventos, velas |
| `production-readonly` | datos públicos de producción, **solo lectura** | solo velas (para el backtest) |

| Modo | Qué es |
|---|---|
| `dry-run` | órdenes simuladas, nunca enviadas |
| `exchange` | órdenes enviadas al exchange del entorno (testnet o demo) |

Cada repositorio se crea para un entorno (y modo) y **todas** sus consultas y
reportes filtran por él. La base de datos también lo garantiza por su cuenta:
no acepta órdenes, posiciones ni eventos de producción, y un trigger impide que
una ejecución o una posición quede enlazada a una orden de otro entorno.

### Tablas

| Tabla | Contenido |
|---|---|
| `orders` | cada orden: ID de Binance, `clientOrderId` propio, par, lado, tipo, cantidad, precio, estado, cantidad ejecutada, precio promedio, comisión y timestamps. **Incluye las rechazadas**, con su origen (`risk` o `exchange`), código y motivo |
| `order_fills` | ejecuciones parciales de cada orden, con su comisión (moneda original y valor en USDT). La misma ejecución nunca se cuenta dos veces |
| `positions` | compra → venta, con comisiones y PnL realizado |
| `risk_state` | parada activa, una fila por entorno × modo |
| `events` | bitácora: paradas, reanudaciones, fallos al cancelar |
| `candles` | caché de velas cerradas; clave única (entorno, par, intervalo, inicio) |

Estados de una orden: `pending` (registrada, aún sin confirmar) → `open` →
`partially_filled` → `filled`, o bien `canceled` / `expired` / `rejected`.

### Caché de velas y huecos

Las velas se guardan solo si están **cerradas** y **alineadas** a su intervalo;
repetir una descarga no crea duplicados. Antes de un backtest se buscan
**huecos** (velas faltantes en el rango) y se muestra un aviso con cada hueco y
el porcentaje faltante: un hueco puede ser real (mantenimiento de Binance) o un
error de descarga, y en ambos casos el backtest saltaría ese periodo.

## Datos de mercado

Todo el flujo de datos está en [src/data/](src/data/). La estrategia **solo recibe
velas cerradas**: la vela en curso cambia hasta su cierre y una señal basada en
ella podría desaparecer.

### Fuentes (`DATA_FEED`)

| Modo | Cómo llegan las velas |
|---|---|
| `rest` (por defecto) | consulta REST ~2 s después de cada cierre, más una consulta de precio cada 15 s |
| `ws` | stream WebSocket `<par>@kline_<intervalo>`; REST solo para rellenar huecos |

En modo `ws` se usa un cliente propio (paquete `ws`) en lugar de `watchOHLCV` de
ccxt, porque ccxt descarta el campo `x` con el que Binance indica si la vela
está cerrada. Las actualizaciones de la vela en curso solo actualizan el precio.

### Conexión WebSocket

- **Pings:** Binance envía un ping cada ~20 s y corta si no recibe el pong; el bot
  responde cada uno.
- **Cierre a las 24 h:** Binance corta toda conexión a las 24 h. El bot la rota
  por su cuenta a las 23 h y, si igual se corta, reconecta.
- **Conexión zombi:** sin mensajes ni pings durante 60 s, se fuerza la reconexión.
- **Reconexión** automática con backoff exponencial (1 s, 2 s, 4 s… hasta 60 s) y
  jitter (una parte al azar, para no reintentar todos a la vez).
- **Relleno de huecos:** al reconectar, las velas cerradas durante el corte se
  descargan por REST (solo las que faltan en el caché, sin duplicados) **antes**
  de reanudar. Solo se emite la más reciente: una señal de hace varias velas no
  se ejecuta tarde.

### Límites de la API

- El peso usado se lee de la cabecera `X-MBX-USED-WEIGHT-1M` de cada respuesta.
  Al llegar al 80% del límite (6000 por minuto), el bot espera al minuto siguiente.
- **429** (demasiadas peticiones): se espera lo que indica `Retry-After`.
- **418** (IP bloqueada por ignorar los 429): se detienen **todas** las peticiones y
  se registra un error con la hora de fin del bloqueo.

### Hora del servidor

La hora se sincroniza con Binance al arrancar y cada 30 minutos (compensando la
latencia de la red). Se usa para firmar las peticiones (evita el error `-1021`
de timestamp) y para decidir cuándo una vela está cerrada.

### Datos desactualizados

Si pasan más de `DATA_STALE_AFTER_SECONDS` sin señales de la fuente (mensajes,
pings o respuestas REST), o sin la última vela cerrada, los datos se marcan
**desactualizados** y el gestor de riesgo **bloquea toda orden nueva** hasta que
se recuperen. También están bloqueadas mientras se rellenan huecos.

## Ejecución de órdenes

Todo el código está en [src/execution/](src/execution/). El **ejecutor** es la
única forma de operar, y cada orden sigue siempre el mismo flujo, en dry-run y
en testnet/demo:

1. Calcula la cantidad (tope por operación, o la posición a cerrar).
2. Genera un `clientOrderId` propio y consulta al **gestor de riesgo**. Si rechaza,
   la orden se registra como rechazada, con su motivo, y no sale.
3. Guarda la orden en SQLite como `pending` **antes** de enviarla.
4. La envía con la aprobación del riesgo.
5. Registra las ejecuciones y actualiza la posición con lo **realmente ejecutado**.

### Nadie se salta el riesgo

- La aprobación del riesgo es un objeto que solo `checkOrder()` puede crear, válido
  para **una** orden exacta (mismo `clientOrderId`, lado, cantidad…), **una** vez y
  durante 30 s. El envío simulado y el real la exigen.
- El cliente ccxt tiene un **filtro de red**: toda petición que crea órdenes
  (`/api/v3/order`, OCO, SOR…) debe llevar un `clientOrderId` autorizado con esa
  aprobación. Ni `exchange.createOrder()` llamado directamente puede enviar una orden.
- La WebSocket API de Binance (otro canal para crear órdenes) está bloqueada.

### Idempotencia: nunca reenviar a ciegas

Si al enviar hay un timeout o error de red, no se sabe si la orden llegó. El bot
**no la reenvía**: espera a que venza la ventana de Binance (`recvWindow`, 5 s;
pasado ese tiempo la orden ya no puede entrar) y la **consulta por `clientOrderId`**:

| Resultado de la consulta | Qué hace el bot |
|---|---|
| La orden existe | registra su estado y ejecuciones reales |
| No existe | la marca como no creada (`NOT_CREATED`) |
| No se puede consultar | queda `pending` y bloquea nuevas órdenes del par hasta resolverla |

Además, una señal de la estrategia produce como máximo **una** orden (clave única
por señal), y el filtro de red rechaza enviar dos veces el mismo `clientOrderId`.

### Reconciliación al iniciar

Antes de operar, el bot compara su registro con Binance:

- **Órdenes sin terminar** en el registro: consulta su estado real y lo registra.
- **Órdenes abiertas en Binance** que el bot no registró → diferencia.
- **Saldos**: esperado = foto de referencia + ejecuciones registradas desde
  entonces (con comisiones). Si Binance dice otra cosa → diferencia. La primera
  vez se toma la foto de referencia.

Si hay diferencias, se registran (log y bitácora) y **no se opera** hasta
resolverlas:

```bash
npm run reconcile                         # muestra las diferencias
npm run reconcile -- --cancel-unknown     # cancela órdenes abiertas que el bot no registró
npm run reconcile -- --accept-balances    # acepta los saldos actuales (tras revisarlos)
```

`--accept-balances` es útil, por ejemplo, cuando el testnet reinicia los saldos.

### Dry-run

Está activado por defecto y usa **el mismo flujo** (riesgo, registro, comisión y
slippage simulados). Las órdenes se registran con modo `dry-run` y su
`clientOrderId` empieza con `sbtp-`. Para enviar órdenes al testnet/demo hay que
escribir exactamente `DRY_RUN=false` en el `.env`. Al arrancar se muestra una
advertencia destacada y hay 5 s para cancelar con Ctrl+C.

### Ejecuciones parciales

Una orden de mercado puede ejecutarse solo en parte (queda `expired`). La posición
registra la cantidad ejecutada, descontando la comisión si se cobró en la moneda
base. En una venta parcial, la parte vendida queda como operación cerrada y la
posición sigue abierta con lo que queda.

## Ciclo del bot

`npm start` ejecuta [src/index.js](src/index.js) → [src/app.js](src/app.js) (arranque) →
[src/bot.js](src/bot.js) (ciclo y apagado).

### Arranque, en este orden

| Paso | Qué verifica | Si falla |
|---|---|---|
| 1. Configuración y entorno | config válida, advertencia si no es dry-run, estrategia, guardia de red (bloqueo de mainnet), conexión, mercado y credenciales | no arranca |
| 2. Hora | sincroniza con el servidor de Binance | no arranca |
| 3. Estado de riesgo | parada guardada, kill switch, posiciones y PnL del día desde SQLite | no arranca |
| 4. Reconciliación | órdenes y saldos contra Binance; límites de riesgo | no arranca |
| 5. Velas históricas | suficientes para calentar los indicadores | no arranca |

Si un paso falla, el bot cierra lo que alcanzó a abrir y explica el paso y el motivo.

### Una vela a la vez

Cada vela cerrada pasa por: límites de riesgo → estrategia → orden (si hay
señal) → límites otra vez. Las velas se procesan **de a una y en orden**: si llega
una mientras otra se procesa, espera en la cola. Una señal de una vela que cerró
hace más de `DATA_STALE_AFTER_SECONDS` (por ejemplo, rellenada tras un corte) no se
opera. Si procesar velas falla 3 veces seguidas, el bot se apaga de forma segura.

### Apagado ordenado

Con **Ctrl+C** (SIGINT) o **SIGTERM**, y también ante una excepción no controlada o
una promesa rechazada sin manejar:

1. Deja de aceptar velas y señales nuevas (las que estaban en cola se descartan).
2. Espera a que termine la operación en curso, como máximo `SHUTDOWN_TIMEOUT_SECONDS`.
3. Cancela las órdenes pendientes no ejecutadas.
4. Guarda el estado y el motivo en SQLite (evento `SHUTDOWN`).
5. Cierra el WebSocket, los timers, el cliente y la base de datos.

**Las posiciones abiertas NO se cierran ni se venden** al apagar: vender es una
decisión de trading, y apagar el bot no debe tomar decisiones de trading. Un
**segundo Ctrl+C** fuerza la salida inmediata (queda registrado como advertencia).
El kill switch y la pérdida máxima diaria también terminan en este apagado.

### Heartbeat

Cada `HEARTBEAT_SECONDS` se registra el estado: entorno y modo, estrategia,
última vela procesada, precio, posiciones abiertas, PnL del día y estado de los datos.

## Backtest

```bash
npm run backtest -- --from 2025-01-01 --to 2025-07-01
npm run backtest -- --from 2025-01-01 --to 2025-07-01 --split 2025-05-01
npm run backtest -- --from 2025-01-01 --to 2025-07-01 --split 2025-05-01 --grid '{"fast":[5,9,12],"slow":[21,30]}'
```

| Opción | Por defecto | Qué hace |
|---|---|---|
| `--from`, `--to` | obligatorias | período en UTC (`to` exclusivo) |
| `--symbol`, `--timeframe` | `SYMBOL`, `TIMEFRAME` | par e intervalo |
| `--strategy`, `--params` | `STRATEGY`, `STRATEGY_PARAMS` | estrategia y parámetros (JSON) |
| `--capital` | `BACKTEST_CAPITAL` (20) | capital inicial en USDT |
| `--fee`, `--slippage-bps` | `FEE_RATE`, `SLIPPAGE_BPS` | comisión y slippage simulados |
| `--split FECHA` | — | ajuste en `[from, split)`, validación en `[split, to)` |
| `--grid JSON` | — | valores a probar en el período de ajuste (requiere `--split`) |
| `--allow-gaps` | no | correr aunque falten velas |
| `--no-save` | no | no guardar en SQLite ni exportar CSV |

Los límites de riesgo (`MAX_TRADE_USDT`, `MAX_DAILY_LOSS_USDT`, `MAX_OPEN_POSITIONS`) son los del `.env`.

### Datos: producción, solo lectura

Las velas vienen de `data-api.binance.vision`, el dominio de Binance que solo sirve
datos públicos de mercado (ahí los endpoints de órdenes no existen). El cliente
([src/backtest/market-data-client.js](src/backtest/market-data-client.js)) no usa
API keys, no usa ccxt ni el módulo de ejecución, y no tiene ningún método para
órdenes. Las velas se guardan en el caché SQLite con entorno `production-readonly`:
repetir un backtest no vuelve a descargarlas.

**Huecos:** si faltan velas en el período (por ejemplo, la caída de Binance del
24/03/2023 entre 12:40 y 13:59 UTC), el backtest avisa y **no corre**, salvo con
`--allow-gaps`.

### Cómo simula ([src/backtest/engine.js](src/backtest/engine.js))

- **Los mismos módulos que en vivo:** la misma clase de estrategia, el mismo
  `RiskManager` (tope por operación, máximo de posiciones, filtros del par,
  pérdida diaria, PnL con comisiones), el mismo `OrderExecutor` y la misma
  simulación de ejecución que el dry-run. Todo sobre una base SQLite en memoria,
  propia de cada corrida, con un reloj simulado.
- **Sin sesgo de futuro:** la señal se calcula al **cierre** de una vela y la orden
  se ejecuta a la **apertura de la vela siguiente**, más slippage. Una señal en la
  última vela del período no se ejecuta.
- **Capital:** cada compra usa como máximo `min(MAX_TRADE_USDT, saldo disponible)`,
  redondeado al paso del par. Si el capital no alcanza el mínimo del par, no corre.
- **Pérdida diaria:** si se alcanza, el riesgo detiene el "bot" igual que en vivo
  (no se envían órdenes, ni ventas); aquí la reanudación manual se simula a las
  00:00 UTC del día siguiente.
- **Posición abierta al final:** se valora como si se vendiera al último cierre
  (con slippage y comisión), pero no cuenta como operación cerrada.
- **Reproducible:** mismas velas y parámetros → mismo resultado, siempre.

### Reporte

Número de operaciones, ganancia/pérdida neta (USDT y %), % de operaciones ganadoras,
ganancia y pérdida promedio, profit factor (ganancias brutas ÷ pérdidas brutas),
máximo drawdown (USDT y %), comisiones pagadas, y comparación con **comprar y
mantener** en el mismo período (con la misma comisión, slippage y filtros).

### Ajuste y validación

Con `--split`, cada período se corre y reporta por separado, con su propio capital.
Con `--grid`, cada combinación válida de parámetros se prueba **solo en el período
de ajuste**, se elige la mejor (mayor PnL neto) y **solo esa** se corre en el de
validación, con datos que no se usaron para elegirla. Un buen resultado en el
ajuste y malo en la validación es la señal clásica de *sobreajuste*.

### Resultados guardados

Cada resultado se guarda en SQLite (`backtest_runs`: parámetros, período, fecha,
comisión, slippage, límites, filtros del par y todas las métricas; `backtest_trades`:
cada operación). Ajuste y validación comparten `group_id`. Las operaciones se
exportan a CSV en `data/backtests/backtest-<id>-<período>.csv`.
