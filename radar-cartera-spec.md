# Radar Cartera — Especificación del proyecto

> Documento base para construir el proyecto con Claude Code.
> Uso **personal** (un solo usuario), **Android**, sin publicar en Google Play.
> Idioma de la interfaz y de las notificaciones: **español**.

---

## 1. Qué es y para qué sirve

Una app de móvil sencilla que:

1. Guarda **mis acciones** (las que tengo, con cantidad y precio de compra) y una **watchlist** (las que vigilo sin tenerlas).
2. Sigue el **precio en tiempo casi real** (cada 5 minutos), incluidos **pre-market y after-hours**.
3. Muestra, para cada acción, el **consenso de analistas**: precio objetivo **medio**, **mediana**, **máximo**, **mínimo** y **número de analistas**.
4. Compara el precio actual con esos objetivos, con **mi precio de entrada** y con **mis propios objetivos** (venta y compra).
5. Me **manda notificaciones push** cuando pasa algo relevante: me acerco al consenso, llego a mi objetivo, cruzo el mínimo de los analistas, cambia el consenso, etc.
6. Me deja **ordenar y filtrar** la lista por cualquiera de esas métricas.

**Principio rector: lo más simple posible que cumpla la tarea.** Nada de cuentas de usuario, nada de tiendas de apps, nada de infraestructura de pago.

### Fuera de alcance (v1)

- Conexión con Trading 212 (ver §14, se deja preparada para el futuro).
- Operar (comprar o vender) desde la app. **Nunca.**
- Multiusuario, publicación en tiendas, gráficos históricos complejos.

---

## 2. Decisiones ya tomadas

| Tema | Decisión | Motivo |
|---|---|---|
| Plataforma | Android | Es el móvil del usuario |
| Tipo de app | **PWA** (app web instalable en la pantalla de inicio) | Sin APK ni tienda; se actualiza sola. Si más adelante se quiere APK, se puede envolver con Bubblewrap/TWA (ver §14) |
| Backend | **Cloudflare Worker** (plan gratuito) + **KV** + **Cron Trigger cada 5 min** | Gratis, sin servidor que mantener, cron fiable. Las tareas en segundo plano del propio móvil no permiten revisar cada 5 min de forma fiable |
| Notificaciones | **ntfy** (app gratuita en Android + `https://ntfy.sh`) | Mucho más simple que Web Push (no hace falta cifrado VAPID). El móvil se suscribe a un "topic" secreto |
| Trading 212 | **No conectar en v1.** Entradas manuales | Evitar guardar una clave del bróker. Con entradas manuales + importación masiva es suficiente |
| Seguridad de la app | Un **token secreto** (`APP_TOKEN`) en todas las llamadas a la API | Es de uso personal; no hace falta sistema de login |

---

## 3. Arquitectura

```
┌─────────────── Móvil Android ───────────────┐
│  PWA "Radar Cartera" (Chrome → Añadir a      │
│  pantalla de inicio)                         │
│   · lista, filtros, orden, añadir/editar     │
│   · llama a /api/* con Bearer APP_TOKEN      │
│                                              │
│  App ntfy (suscrita al topic secreto)        │
│   · recibe las notificaciones push           │
└───────────────▲──────────────────▲───────────┘
                │ HTTPS            │ push
┌───────────────┴──────────────────┴───────────┐
│ Cloudflare Worker                            │
│  · sirve la PWA (static assets /public)      │
│  · API REST /api/*                           │
│  · scheduled(): cron */5 * * * *             │
│       1. precios (si algún mercado abierto)  │
│       2. evaluar reglas de alerta            │
│       3. refrescar consensos caducados       │
│       4. enviar avisos → ntfy.sh/<topic>     │
│  · KV: un único documento JSON "state"       │
└───────────────┬──────────────────────────────┘
                │ fetch
   ┌────────────┼─────────────────────────────┐
   │ Yahoo Finance (precio, pre/post, búsqueda)│
   │ Financial Modeling Prep (consenso)        │
   │ Finnhub (opcional: nº analistas, respaldo)│
   └───────────────────────────────────────────┘
```

### Estructura de carpetas

```
radar-cartera/
├── wrangler.toml
├── package.json
├── src/
│   ├── worker.js        # entrada: fetch() + scheduled()
│   ├── api.js           # rutas /api/*
│   ├── sources.js       # Yahoo, FMP, Finnhub (+ mocks)
│   ├── alerts.js        # motor de reglas con histéresis
│   ├── notify.js        # ntfy + silencio nocturno
│   ├── state.js         # carga/guardado en KV
│   └── time.js          # horarios de mercado (NY / Madrid)
├── public/
│   ├── index.html       # PWA (HTML + CSS + JS, sin frameworks)
│   ├── manifest.webmanifest
│   ├── sw.js            # service worker mínimo (instalable + caché del shell)
│   └── icon.svg / icon-192.png / icon-512.png
├── test/
│   └── alerts.test.js   # tests del motor de alertas y de la ordenación
└── README.md            # guía de despliegue en español
```

Sin frameworks en el frontend (HTML + JS vanilla). Tests con `vitest` o `node:test`.

---

## 4. Fuentes de datos

> ⚠️ **Verificar al empezar**: las condiciones de los planes gratuitos cambian. La primera tarea del proyecto es un script/endpoint de **diagnóstico** (§8, `/api/diag`) que pruebe cada fuente con un ticker y muestre qué funciona.
> Yahoo Finance **no es una API oficial**: puede cambiar sin aviso y su uso es aceptable solo para fines personales. Por eso cada dato tiene una fuente de respaldo.

### 4.1 Precio en vivo (incluye pre-market y after-hours)

**Principal — Yahoo chart (sin clave):**

```
GET https://query1.finance.yahoo.com/v8/finance/chart/{SYMBOL}?interval=5m&range=1d&includePrePost=true
Header: User-Agent de navegador
```

- `chart.result[0].meta`: `regularMarketPrice`, `chartPreviousClose` / `previousClose`, `currency`, `longName`/`shortName`, `fullExchangeName`, `currentTradingPeriod.{pre,regular,post}.{start,end}`.
- Precio actual = **último `close` no nulo** de `indicators.quote[0].close` (con su `timestamp`). Así se captura el pre-market y el after-hours.
- Sesión (`pre` | `regular` | `post` | `closed`) = comparar el timestamp del último dato con `currentTradingPeriod`.
- Funciona con tickers europeos usando sufijo: `ASML.AS`, `SGLN.L`, `AMZ.DE`.

**Respaldo — Finnhub (clave gratuita):** `GET https://finnhub.io/api/v1/quote?symbol=X&token=K` → `c` (precio), `pc` (cierre anterior), `t`. Solo sesión regular.

### 4.2 Búsqueda de tickers (autocompletar)

**Principal — Yahoo search (sin clave):**

```
GET https://query1.finance.yahoo.com/v1/finance/search?q={texto}&quotesCount=8&newsCount=0
```

Filtrar `quoteType` ∈ {`EQUITY`, `ETF`}. Mostrar `symbol`, `longname|shortname`, `exchDisp`.

**Respaldo:** `GET https://finnhub.io/api/v1/search?q=X&token=K`.

### 4.3 Consenso de analistas

**Principal — Financial Modeling Prep (clave gratuita):**

```
GET https://financialmodelingprep.com/stable/price-target-consensus?symbol=X&apikey=K
→ [{ symbol, targetHigh, targetLow, targetConsensus, targetMedian }]
```

Número de analistas y recomendación:

```
GET https://financialmodelingprep.com/stable/grades-consensus?symbol=X&apikey=K
→ [{ strongBuy, buy, hold, sell, strongSell, consensus }]   // analistas = suma
```

**Respaldo 1 — Finnhub:** `GET /api/v1/stock/recommendation?symbol=X&token=K` → tomar el periodo más reciente; analistas = suma de las cinco categorías; recomendación = media ponderada (1 = Strong Buy … 5 = Strong Sell).

**Respaldo 2 — Yahoo quoteSummary** (requiere cookie + crumb):

1. `GET https://fc.yahoo.com` → guardar la cookie de `set-cookie`.
2. `GET https://query2.finance.yahoo.com/v1/test/getcrumb` (con esa cookie) → crumb.
3. `GET https://query2.finance.yahoo.com/v10/finance/quoteSummary/{SYMBOL}?modules=financialData&crumb={crumb}` → `targetMeanPrice`, `targetMedianPrice`, `targetHighPrice`, `targetLowPrice`, `numberOfAnalystOpinions`, `recommendationKey` (valores en `.raw`).

Ventaja del respaldo 2: cubre también muchos valores europeos, donde FMP puede no tener datos.

**Frecuencia:** el consenso cambia poco → refrescar **una vez al día** por símbolo (si `updatedAt` > 20 h), como máximo 4 símbolos por ejecución del cron para repartir las peticiones. Si falla, reintentar tras 6 h.

### 4.4 Presupuesto de peticiones (plan gratuito de Cloudflare)

- **50 subpeticiones por ejecución** del Worker → máximo ~35 precios por ciclo; si hay más símbolos, **rotar** la lista entre ciclos.
- **KV: 1.000 escrituras/día** → guardar **un solo documento** por ciclo (288/día con cron de 5 min) y solo cuando algo cambie.
- FMP gratis tiene un límite diario de llamadas → con consenso 1 vez al día por símbolo (×2 endpoints) sobra para ~40 símbolos.
- **Fuera de mercado no se piden precios** (§6.3).

---

## 5. Modelo de datos (KV, clave `state`)

```jsonc
{
  "items": {
    "NVDA": {
      "symbol": "NVDA",
      "name": "NVIDIA Corporation",
      "kind": "holding",          // "holding" (tengo acciones) | "watch" (watchlist)
      "qty": 16,                  // null en watchlist
      "avg": 204.55,              // mi precio medio de compra; null si no tengo
      "myTarget": 240,            // mi objetivo de venta (opcional)
      "myBuy": 190,               // comprar por debajo de (opcional)
      "note": "Recortar si pasa del 15 %",
      "currency": "USD",
      "addedAt": 1758000000000
    }
  },
  "market": {
    "NVDA": { "price": 226.9, "regularPrice": 226.5, "prevClose": 224.1, "currency": "USD",
              "session": "post", "time": 1758..., "updatedAt": 1758..., "error": null }
  },
  "targets": {
    "NVDA": { "mean": 328.7, "median": 330, "high": 432, "low": 200, "analysts": 61,
              "rating": "Strong Buy", "source": "FMP", "updatedAt": 1758...,
              "prevMean": 310.9, "prevAnalysts": 59, "error": null, "failedAt": null }
  },
  "flags":   { "NVDA:nearMean": true },   // estado de las reglas de alerta (histéresis)
  "log":     [ { "t": 1758..., "symbol": "NVDA", "title": "...", "body": "..." } ],  // últimas 80
  "pending": [ ],                          // avisos retenidos por el silencio nocturno
  "settings": { "nearPct": 3, "consensusChangePct": 1, "entryAlerts": true, "quietNight": true },
  "rot": 0,                                // índice de rotación de precios
  "lastRun": 1758...
}
```

Todos los precios se guardan en la **moneda de cotización** del valor (USD para EE. UU., EUR para Xetra/Ámsterdam, GBp para Londres). El usuario introduce sus precios en esa misma moneda.

---

## 6. Funcionalidades

### 6.1 Añadir y editar acciones

- Botón **+** → buscador con **autocompletar** (§4.2, debounce 350 ms). Si no hay resultados, Enter acepta el ticker tal cual.
- Formulario:
  - Interruptor **"Tengo acciones"** → si está activo, pide **cantidad** y **mi precio de compra (medio)**; si no, va a la watchlist.
  - **Mi objetivo de venta** (opcional).
  - **Comprar por debajo de** (opcional).
  - **Nota** (opcional).
- Al guardar: pedir precio y consenso de ese símbolo **inmediatamente** y evaluar las reglas **sin notificar** (para no recibir avisos de condiciones que ya se cumplen en el momento de añadir).
- Editar: tocar una tarjeta abre el mismo formulario con los datos, el bloque de consenso (medio, mediana, máx., mín., analistas, fecha y fuente), y botones **Actualizar consenso ahora** y **Eliminar** (con doble pulsación de confirmación).
- Pasar de watchlist a "tengo" (o al revés) es solo cambiar el interruptor.

### 6.2 Importación masiva

En Ajustes, un cuadro de texto; una línea por valor:

```
TICKER, cantidad, precio medio, objetivo venta, precio compra
NVDA, 16, 204.55, 240
MSFT, 1.5, 386.59
ADBE                     ← solo ticker = watchlist
```

Separadores aceptados: coma, punto y coma, tabulador. Decimales con punto o coma.

### 6.3 Actualización de precios

- Cron `*/5 * * * *`.
- Solo pide precios si **algún mercado puede estar abierto**:
  - EE. UU.: lunes a viernes, 04:00–20:05 hora de Nueva York (pre + normal + after-hours).
  - Europa: lunes a viernes, 08:00–17:40 hora de Madrid.
  - (No hace falta calendario de festivos en v1: un festivo solo cuesta unas peticiones inútiles.)
- Botón **Actualizar** en la app → fuerza un ciclo completo al momento.
- La app recarga el estado cada 60 s mientras está en primer plano y al volver a abrirse.

### 6.4 Tarjeta de cada acción

```
┌──────────────────────────────────────────────┐
│ NVDA  [TENGO]                226,94 $ [AFTER]│
│ NVIDIA Corporation                +1,27 % hoy│
│                                              │
│   ▼entrada     ●precio   │consenso  │mi obj. │
│ ──────[██████████████████████████]────────── │
│ mín 200                              máx 432 │
│                                              │
│ [Consenso 328,66 +44,8 %] [Máx 432 +90 %]    │
│ [Mín 200 −12 %] [61 analistas · Strong Buy]  │
│ [Mi objetivo 240 +5,8 %]                     │
│ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  │
│ 16 acc. · Entrada 204,55 $ · +10,9 % (+358 $)│
│ · Valor 3.631 $                              │
└──────────────────────────────────────────────┘
```

- **Barra de rango**: franja del mínimo al máximo de los analistas; marcas para el consenso (línea azul), el precio actual (punto), mi entrada (triángulo) y mi objetivo (línea verde). La escala se ajusta para que todos los puntos quepan.
- Chips en verde si el potencial es positivo y en rojo si es negativo.
- Distintivo `PRE` / `AFTER` cuando el precio viene de sesión extendida.
- Si una fuente falla, línea pequeña en rojo con el error (p. ej. "Consenso: FMP 402").

### 6.5 Ordenación (el usuario elige, ascendente o descendente)

| Criterio | Cálculo |
|---|---|
| Potencial al consenso medio | (medio − precio) / precio |
| Potencial al objetivo máximo | (máx. − precio) / precio |
| Distancia al objetivo mínimo | (mín. − precio) / precio |
| Distancia a mi objetivo de venta | (miObjetivo − precio) / precio |
| Distancia a mi precio de compra | (miCompra − precio) / precio |
| Ganancia sobre mi precio de entrada | (precio − entrada) / entrada |
| Variación de hoy | (precio − cierre anterior) / cierre anterior |
| Valor de mi posición | cantidad × precio |
| Nº de analistas | analysts |
| Ticker (A-Z) | alfabético |

Los valores sin dato van siempre **al final**, sea cual sea la dirección. La elección de orden y pestaña se recuerda en `localStorage`.

### 6.6 Filtros (pestañas)

**Todas · Tengo · Watchlist · Alertas** (la última muestra el historial de avisos).

Cabecera con resumen: nº de posiciones, nº en watchlist, cuántas cotizan **por encima del consenso**, y el valor total y la rentabilidad de las posiciones, agrupados por moneda (sin conversión en v1).

### 6.7 Alertas

Cada regla se dispara **una sola vez** al entrar en la condición y se **rearma** solo cuando el precio sale con un margen (histéresis). Así no llega el mismo aviso cada 5 minutos. `N` = `settings.nearPct` (por defecto 3 %).

| Clave | Se dispara cuando | Se rearma cuando | Prioridad ntfy |
|---|---|---|---|
| `nearMean` | \|precio − medio\| / medio ≤ N | la distancia > 1,7·N | 3 |
| `aboveMean` | precio ≥ consenso medio | precio < medio·(1 − N) | 4 |
| `aboveHigh` | precio ≥ objetivo máximo | precio < máx.·0,97 | 4 |
| `belowLow` | precio ≤ objetivo mínimo | precio > mín.·1,03 | 4 |
| `nearMyTarget` | 0 < (miObjetivo − precio)/miObjetivo ≤ N | distancia > 1,7·N o ya alcanzado | 3 |
| `hitMyTarget` | precio ≥ mi objetivo de venta | precio < objetivo·0,98 | 5 |
| `hitMyBuy` | precio ≤ mi precio de compra | precio > compra·1,02 | 5 |
| `belowEntry` | cruza mi precio de entrada (en cualquier sentido, con margen de 0,5 %) | — (registra el lado) | 3 |
| `consensusChange` | al refrescar, el medio cambia ≥ `consensusChangePct` % o cambia el nº de analistas | — | 3 |

Textos de ejemplo:

- *"NVDA cerca del consenso" — "226,94 USD (after-hours) · consenso medio 232,00 (−2,2 %)"*
- *"NVDA: nuevo consenso de analistas" — "Objetivo medio 310,91 → 328,66 (+5,7 %) · 61 analistas · rango 200–432"*
- *"MSFT ha llegado a tu objetivo" — "560,10 USD ≥ tu objetivo de venta 560,00"*

**Silencio nocturno** (00:00–07:00, hora de Madrid, configurable): los avisos con prioridad < 5 se guardan en `pending` y se envían a las 07:00; si son más de 3, se agrupan en uno solo ("5 avisos de la noche").

Todos los avisos se guardan también en `log` (visible en la pestaña Alertas).

### 6.8 Notificaciones (ntfy)

```
POST https://ntfy.sh/{NTFY_TOPIC}
Headers: Title, Tags (emoji ntfy), Priority (1-5), Click (URL de la PWA)
Body: texto del aviso
```

- El topic funciona como contraseña: generar uno largo y aleatorio (p. ej. `radar-` + 24 caracteres aleatorios).
- Los títulos con tildes deben codificarse (RFC 2047 `=?UTF-8?B?...?=`) o enviarse como parámetro de query `?title=`.
- Botón **Enviar notificación de prueba** en Ajustes.

### 6.9 Ajustes

- Contraseña de la app (`APP_TOKEN`), guardada en `localStorage`.
- `nearPct`, `consensusChangePct`, `entryAlerts`, `quietNight`.
- Importación masiva.
- Actualizar todos los consensos.
- **Diagnóstico**: llama a `/api/diag?symbol=X` y muestra qué fuentes responden.

---

## 7. Lógica del cron (pseudocódigo)

```
scheduled():
  s = loadState()
  if no items: return
  flush pending notifications if quiet hours are over
  if marketsMaybeOpen():
      symbols = rotate(items, s.rot) limited to 35
      fetch quotes in parallel (Promise.allSettled)
      for each symbol: evaluateAlerts(symbol)
  refreshTargets(stale symbols, max 4)   // notifies consensusChange
  s.lastRun = now
  saveState(s)                           // a single KV write
```

---

## 8. API (todas requieren `Authorization: Bearer <APP_TOKEN>`)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/state` | Estado completo para la app |
| POST | `/api/refresh` | Fuerza un ciclo (precios + alertas + consensos caducados) |
| GET | `/api/search?q=` | Autocompletar tickers |
| POST | `/api/items` | Crear/actualizar un valor `{symbol,name,kind,qty,avg,myTarget,myBuy,note}` |
| DELETE | `/api/items/:symbol` | Eliminar un valor (y sus flags, precios y consenso) |
| POST | `/api/import` | `{text}` importación masiva |
| POST | `/api/targets/refresh` | `{symbol?}` fuerza el refresco de consenso (uno o todos) |
| POST | `/api/settings` | Guarda ajustes |
| POST | `/api/test-notification` | Envía un push de prueba |
| GET | `/api/diag?symbol=` | Prueba cada fuente de datos y devuelve ok/error |

Respuestas en JSON. Errores: `{ "error": "mensaje en español" }` con código HTTP adecuado. `401` si falta o es incorrecto el token.

---

## 9. PWA

- `manifest.webmanifest`: `name` "Radar Cartera", `display: standalone`, `start_url: /`, `theme_color`, iconos 192 y 512.
- `sw.js`: caché del shell (index, manifest, iconos) con estrategia *network-first* para `/api/*` (sin caché) y *cache-first* para estáticos.
- Diseño móvil primero, **modo claro y oscuro** (`prefers-color-scheme`), números tabulares, áreas seguras (`env(safe-area-inset-*)`), botones de al menos 40 px.
- Formularios con `inputmode="decimal"` y aceptando coma decimal.
- Sin dependencias externas (ni CDN, ni frameworks).

---

## 10. Seguridad

- `APP_TOKEN`, `NTFY_TOPIC`, `FMP_KEY` y `FINNHUB_KEY` como **secretos de Wrangler** (`wrangler secret put`), nunca en el repositorio.
- `.gitignore` con `.dev.vars`, `node_modules`, `.wrangler`.
- Comparación del token en tiempo constante.
- Los datos de la cartera solo viven en el KV de la cuenta de Cloudflare del usuario.
- **Nunca** guardar claves del bróker con permiso de operar.

---

## 11. Despliegue (guía para el README, en Windows)

1. Instalar **Node.js LTS** desde nodejs.org.
2. Crear cuenta gratuita en **Cloudflare**.
3. En la carpeta del proyecto: `npm install` y `npx wrangler login`.
4. `npx wrangler kv namespace create KV` → copiar el `id` en `wrangler.toml`.
5. Conseguir las claves gratuitas: **financialmodelingprep.com** (FMP_KEY) y, opcionalmente, **finnhub.io** (FINNHUB_KEY).
6. Secretos:
   ```
   npx wrangler secret put APP_TOKEN
   npx wrangler secret put NTFY_TOPIC
   npx wrangler secret put FMP_KEY
   npx wrangler secret put FINNHUB_KEY
   ```
7. `npx wrangler deploy` → devuelve una URL `https://radar-cartera.<cuenta>.workers.dev`.
8. En el Android:
   - Abrir la URL en **Chrome** → menú ⋮ → **Añadir a pantalla de inicio**.
   - Abrir la app → Ajustes → pegar el `APP_TOKEN`.
   - Instalar **ntfy** (Google Play o F-Droid) → **Suscribirse a tema** → mismo nombre que `NTFY_TOPIC`.
   - Ajustes de la app → **Enviar notificación de prueba**.
9. Opcional: añadir `APP_URL` como variable para que al tocar la notificación se abra la app.

`wrangler.toml` de referencia:

```toml
name = "radar-cartera"
main = "src/worker.js"
compatibility_date = "2025-09-01"

[assets]
directory = "./public"
binding = "ASSETS"

[[kv_namespaces]]
binding = "KV"
id = "PEGAR_AQUI_EL_ID"

[triggers]
crons = ["*/5 * * * *"]

# [vars]
# APP_URL = "https://radar-cartera.TU_CUENTA.workers.dev"
# MOCK = "1"   # datos simulados para pruebas
```

---

## 12. Plan de implementación por fases

Cada fase termina con algo que funciona y se puede probar.

**Fase 0 — Esqueleto y diagnóstico**
- Proyecto Wrangler, `wrangler.toml`, estructura de carpetas.
- `sources.js` con las tres fuentes y el endpoint `/api/diag`.
- Modo `MOCK=1` con precios y consensos simulados (deterministas por ticker, con pequeñas oscilaciones en el tiempo).
- ✅ Aceptación: `wrangler dev` + `/api/diag?symbol=AAPL` muestra qué fuentes responden.

**Fase 1 — Datos y API**
- `state.js`, rutas `/api/state`, `/api/items`, `/api/search`, `/api/refresh`, `/api/import`.
- ✅ Aceptación: se añade un ticker con curl y aparecen precio, sesión y consenso.

**Fase 2 — PWA**
- Lista con tarjetas, barra de rango, pestañas, ordenación, formulario con autocompletar, ajustes, importación.
- ✅ Aceptación: en el móvil se puede instalar, añadir, editar, borrar, ordenar y filtrar.

**Fase 3 — Cron y alertas**
- `scheduled()`, horario de mercado, rotación, `alerts.js` con histéresis, `notify.js` con ntfy y silencio nocturno, pestaña Alertas.
- ✅ Aceptación: con `MOCK=1` y umbrales ajustados se reciben notificaciones reales en ntfy **una sola vez** por cruce.

**Fase 4 — Pulido y despliegue**
- Service worker, iconos, modo oscuro, mensajes de error claros, README de despliegue.
- ✅ Aceptación: desplegado en workers.dev y usado un día de mercado real sin errores en `wrangler tail`.

---

## 13. Tests mínimos

- **Motor de alertas**: para cada regla, una secuencia de precios que entra, se mantiene, sale sin margen (no rearma), sale con margen (rearma) y vuelve a entrar (segundo aviso).
- **Ordenación**: valores nulos siempre al final en ambas direcciones.
- **Horario de mercado**: casos de fin de semana, 03:59 y 04:00 en Nueva York, 17:40 en Madrid, cambio de horario de verano.
- **Importación**: separadores y decimales con coma.
- **Silencio nocturno**: avisos retenidos y agrupados a las 07:00.

---

## 14. Mejoras futuras (no hacer en v1)

1. **Importar desde Trading 212** con su API oficial usando una clave con **solo permisos de lectura** (si Trading 212 lo permite al crearla), guardada como secreto en el Worker, **nunca en el móvil**. Solo lectura de posiciones y precios medios; jamás permisos de órdenes.
2. **Conversión a EUR** del valor total (tipo de cambio `EURUSD=X` de Yahoo).
3. **Histórico del consenso** (guardar una muestra al día) y mini-gráfico de su evolución.
4. **Resumen diario** a una hora fija (p. ej. 22:15): las 3 más cerca del consenso, cambios de consenso del día y posiciones por encima del 15 % de la cartera.
5. **Aviso de concentración**: una posición supera el X % del valor total.
6. **APK instalable** envolviendo la PWA con Bubblewrap (Trusted Web Activity), si se quiere un icono "de verdad".
7. **Calendario de resultados** (fecha del próximo informe trimestral) en la tarjeta.

---

## 15. Prompt inicial sugerido para Claude Code

```
Lee radar-cartera-spec.md. Vamos a construir el proyecto por fases, en el
orden de la sección 12. Empieza por la Fase 0: crea la estructura, wrangler.toml,
sources.js con las fuentes de la sección 4, el modo MOCK y el endpoint /api/diag.
Usa JavaScript sin frameworks, comentarios en español y tests con node:test.
Antes de pasar a la siguiente fase, ejecuta los tests y enséñame cómo probar lo
hecho con `npx wrangler dev`. No añadas nada que no esté en la especificación sin
preguntarme.
```

---

## 16. Advertencia

La app muestra datos y consensos de terceros con fines informativos. No es asesoramiento financiero. Los consensos de analistas van por detrás del precio: son una medida del sentimiento, no una predicción. Comprobar siempre el precio en el bróker antes de operar.
