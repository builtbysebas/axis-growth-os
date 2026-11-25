// Única función de Vercel: toda la API pasa por acá (el plan gratis permite
// máx. 12 funciones). Cada módulo registra sus rutas en api/_routes/.
import { createRouter } from './_lib/router.js';
import * as core from './_routes/core.js';
import * as ventas from './_routes/ventas.js';
import * as clientes from './_routes/clientes.js';
import * as contenido from './_routes/contenido.js';
import * as resultados from './_routes/resultados.js';
import * as dashboard from './_routes/dashboard.js';
import * as equipo from './_routes/equipo.js';

export default createRouter([core, ventas, clientes, contenido, resultados, dashboard, equipo]);
