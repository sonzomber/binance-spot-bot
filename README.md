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
| `npm test` | Ejecuta las pruebas |

## Gestión de riesgo

Toda orden pasa por el gestor de riesgo **antes** de enviarse. Si alguna regla
no se cumple, la orden se rechaza con un código y un motivo en el log.

### Límites que se validan antes de cada orden

| Regla | Configuración | Aplica a |
|---|---|---|
| Bot detenido o kill switch activo | — | compras y ventas |
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
