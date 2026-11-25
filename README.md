# Axis Growth OS

El sistema de ventas, clientes, contenido y equipo para negocios de coaching e infoproductos.
Corre gratis en tu propia cuenta de Vercel, con tu propia base de datos. Tus datos son solo tuyos.

## Instalar (unos 3 minutos)

[![Instalar en Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fbuiltbysebas%2Faxis-growth-os&project-name=axis-growth-os&repository-name=axis-growth-os&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22neon%22%2C%22productSlug%22%3A%22neon%22%2C%22protocol%22%3A%22storage%22%7D%5D)

1. Toca el botón **Instalar en Vercel**.
2. Entra con **GitHub** (si no tienes cuenta, se crea gratis en el momento).
3. Vercel te pide:
   - **Un nombre para el repositorio**: deja el que aparece o pon el de tu negocio.
     Deja marcada la casilla para que quede **privado**.
   - **La base de datos (Neon)**: elige el plan **Free** y la región **Washington (iad1)**, y acepta.
4. Toca **Deploy** y espera 1 o 2 minutos.
5. Toca **Continue to Dashboard** y después el link de tu app (termina en `.vercel.app`).
6. Escribe el nombre de tu negocio, tu nombre, tu correo y una contraseña. Listo: ya estás adentro.

> Hazlo de corrido: la primera persona que abre la app crea la cuenta de administrador.

**Después de entrar:**
- En **Ajustes**: revisa la zona horaria y pon tu meta de cash del mes.
- En **Usuarios**: crea a tu equipo (setters, closers y coaches). La app te da el mensaje con el
  acceso listo para mandárselo.
- En **Ajustes → Conectar ManyChat** y **Recibir agendas**: los pasos para que las respuestas a
  tus contenidos y las agendas de Calendly entren solas.

Si la app dice «Falta conectar la base de datos», en Vercel ve a tu proyecto → **Storage** →
crea una base **Neon** (plan Free) conectada al proyecto, y después **Deployments** → los tres
puntitos del último → **Redeploy**.

## Qué trae

| Sección | Qué hace |
|---|---|
| **Ventas** | Agendas en Kanban (arrastrar con el mouse o con el dedo), Lista y Calendario. Cada agenda con sus datos, estatus (para hoy / en espera con recordatorio), notas y el **resultado de la llamada**: una venta crea el cliente con su pago inicial. Filtros por closer, setter y presupuesto. Columnas editables. Aviso de llamadas que pasaron sin resultado. |
| **Clientes** | Kanban por etapas y lista, pagos y saldo, renovaciones, notas, coach asignada y paso automático a «Renovar» cuando faltan 20 días para que venza el programa. |
| **Contenido** | Planificador de Contenido Corto, Stories y Ads (calendario por mes y por semana, y lista), guion, recursos vinculados, comentarios y el **código para ManyChat** de cada pieza. Biblioteca de Recursos y Ángulos. |
| **Resultados** | Qué contenido trae leads, agendas, ventas y cash (atribución manual o último contenido respondido antes de agendar), por ángulo y formato, ROAS de los ads, atribución manual y huecos. |
| **Dashboard** | Cash contra la meta, embudo, show rate, cierre, AOV, facturación, de dónde viene el cash, y pestañas por setter y por closer. |
| **Equipo** | Reporte diario (EOD) por rol con resumen automático, EOD del equipo, metas, usuarios con roles (admin, setter, closer, coach) y ajustes. |

## Desarrollo

```bash
npm install
npm run dev    # http://localhost:3010, con un Postgres local (PGlite en dev/.pgdata)
npm test       # prueba la API real contra un Postgres en memoria
```

```
api/main.js             función única de Vercel → api/_lib/router.js
api/_routes/*.js        rutas por módulo
api/_lib/schema/*.js    tablas (se crean solas al arrancar)
api/_lib/metrics.js     definiciones de las métricas (las usan dashboard, EOD, metas y resultados)
public/css/os.css       estilos base
public/js/core/brand.js nombre del producto
public/js/core/*        barra lateral, paneles, efectos, arrastrar
public/js/pages/*       una pantalla por archivo
```
