# Contrato host y MCP de RPG Night v2

Los esquemas en `shared/session-schema.ts` y `shared/host-schema.ts` son la referencia ejecutable. Los nombres `snake_case` y límites son parte de la interfaz. Toda salida pública pasa por `PublicTurnSchema`, `PublicOperationSchema`, `PublicErrorSchema` o `HostResponseSchema`.

## Herramientas MCP

El host descubre esquemas con el cliente oficial y llama por Streamable HTTP. Mantiene el vínculo de partida y añade `session_id` técnico a partir de una sesión autorizada; el jugador nunca dicta ni el modelo inventa UUIDs. Ninguna herramienta devuelve plantilla privada ni estado interno completo.

| Herramienta | Entrada | Efecto y respuesta |
| --- | --- | --- |
| `list_adventures` | Filtros opcionales de idioma, género, número de jugadores y duración. | Lectura. Aplica todos los filtros declarados y devuelve `ListAdventuresResponse` con `AdventureSummary` públicos; no incluye grafo ni secretos. |
| `prepare_adventure` | `request_id`, premisa, idioma y preferencias acotadas. | Trabajo asíncrono. Devuelve `pending` o resumen público de aventura preparada; nunca el grafo. Solo ofrece aventuras que pasaron validación. |
| `get_operation_status` | `operation_id`. | Lectura `pending`/`ready`/`failed`, con resultado apropiado y seguro. |
| `start_session` | `request_id`, `adventure_id`, `locale` opcional (por defecto `en`), 1–6 nombres. | Crea una partida v2 con la traducción del idioma solicitado y devuelve el primer `PublicTurn`. Repetir la misma petición devuelve el mismo resultado. La sesión conserva el locale para reinicios. |
| `get_session` | `session_id`. | Lectura de `PublicTurn`; no cambia revisión. |
| `submit_action` | `session_id`, `expected_revision`, `request_id` e `interaction` discriminada. | Una sola decisión. `choice` lleva un `choice_id` vigente; `free_action` lleva `affordance_id` y solo los `target_id`, `item_id` o `approach_id` permitidos en esa affordance, más la frase original del jugador. Puede devolver `turn`, `clarification`, operación pendiente o error recuperable. |
| `resolve_check` | `session_id`, `check_id`, `expected_revision`, `request_id`. | El servidor usa RNG, resuelve éxito/contratiempo y retorna un turno. No acepta total elegido por el host. |
| `end_session` | `session_id`, `expected_revision`, `request_id`. | Cierra en la escena actual sin fabricar desenlace, descarta una comprobación pendiente sin tirar y registra el cierre; reintento idempotente. El cómic se prepara después con el historial realmente jugado. |

No se aceptan efectos, resultados, nodos, totales de dado ni cambios de inventario propuestos por el modelo. El `check_id` debe coincidir con la comprobación pendiente. Una acción que requiera tirada devuelve `awaiting_check`; `resolve_check` consume esa comprobación una vez.

## Host HTTP

El navegador conversa únicamente con el host en modo IA. Rutas actualmente implementadas:

| Ruta | Cuerpo | Respuesta |
| --- | --- | --- |
| `POST /api/host/conversations` | `CreateConversationRequest` | `HostResponse`; crea la conversación, opcionalmente vinculada a sesión. |
| `GET /api/host/conversations/:conversation_id` | — | `HostResponse`; restaura la conversación guardada sin repetir su creación. |
| `POST /api/host/conversations/:conversation_id/turns` | `PlayerTurnRequest` | `HostResponse`; puede ser turno, aclaración, operación o error. |
| `POST /api/host/conversations/:conversation_id/pause` | `SessionControlRequest` | `HostResponse` con `conversation.paused=true`; conserva revisión y fase del motor. |
| `POST /api/host/conversations/:conversation_id/resume` | `SessionControlRequest` | `HostResponse` con estado restaurado y recapitulación segura. |
| `GET /api/host/conversations/:conversation_id/operation` | — | Consulta solo la operación de preparación vinculada a esa conversación; al quedar lista actualiza el catálogo, sin iniciar la aventura. |
| `GET /api/host/conversations/:conversation_id/tv` | — | Instantánea pública, pausa de conversación e historial jugado; sin transcripción privada. |
| `GET /api/host/conversations/:conversation_id/events` | — | SSE con las mismas instantáneas públicas. |
| `GET /api/host/conversations/:conversation_id/art/:revision.svg` | — | Arte procedural únicamente para una revisión ya pública. |
| `GET /api/host/conversations/:conversation_id/comic.svg` | — | SVG autocontenido del historial público; el navegador puede rasterizarlo a PNG o imprimirlo a PDF. |

`InteractionProposalSchema` separa intención de ejecución. La propuesta `choice` solo se acepta si su ID está en las opciones públicas actuales. `free_action` contiene una `affordance_id` y referencias opcionales que deben existir en la affordance pública de la escena actual, junto con las palabras del jugador. Cada affordance declara `resolution_choice_id` a una opción de esa misma escena; el servidor deriva de ella la transición y los efectos autorizados, sin aceptar un destino o efecto elegido por el modelo. Objetivos y enfoques de una misma affordance son variantes de una sola intención mecánica; si necesitan consecuencias distintas, deben definirse como affordances distintas. Affordances se declaran en `AdventureDefinition.nodes[].affordances` y solo se proyectan cuando la opción de resolución está habilitada. El servidor revalida IDs, condiciones y posesión al ejecutar y conserva las IDs seleccionadas en el evento privado. `clarification` no muta. Las decisiones y resultados vuelven del MCP; tras una mutación se narra el resultado público confirmado, sin una segunda llamada al modelo que pueda fallar o inventar efectos.

Las rutas HTTP del host de conversación están conectadas en `mcp-server/app.ts`. El host solo se crea en `HOST_MODE=ollama`; con `HOST_MODE=disabled` el navegador recibe HTTP 503 y el juego determinista sigue disponible. El host usa el cliente MCP oficial en `RPG_MCP_URL` y Ollama en `OLLAMA_BASE_URL`; ambas URLs deben ser loopback HTTP. La preparación también usa el proveedor Ollama local configurado por el servidor MCP. El límite de inferencia del host se cancela si el navegador desconecta.

## Errores y resultado pendiente

Los errores tienen `kind: error`, código estable, texto breve y `retryable`. `REVISION_CONFLICT` incluye `current_revision`; el host puede volver a leer antes de pedir una acción nueva. `IDEMPOTENCY_KEY_REUSED` requiere una clave nueva y no autoriza repetir con otra intención. `NOT_FOUND`, `ALREADY_ENDED` y `UNSUPPORTED_SESSION_VERSION` no se ocultan presentando una aventura distinta. `OPERATION_PENDING` enlaza el trabajo activo. Un error MCP, LLM o motor conserva su origen en trazas internas, sin exponer secretos al jugador.

Para una operación asíncrona se devuelve `operation_id`, `created_at` y `expires_at`. El registro privado guarda propietario, petición, huella, plazo, estado y resultado terminal; estos campos internos no aparecen en `PublicOperation`. Solo el servidor confirma efectos. Al vencer o reiniciar, todo trabajo sin commit termina como `failed` recuperable, nunca queda `pending` indefinidamente. La interfaz consulta la operación vinculada y no inicia la aventura automáticamente. La cancelación explícita de trabajos todavía no está expuesta por el host HTTP.

## Reintentos, revisión e idempotencia

Toda mutación de partida requiere `request_id` UUID estable y revisión esperada. Primero se consulta el registro idempotente; la misma clave/comando/huella recibe la respuesta original aunque la revisión haya avanzado. La misma clave para una entrada distinta devuelve `IDEMPOTENCY_KEY_REUSED`. Si la clave es nueva, una revisión incorrecta devuelve `REVISION_CONFLICT` y no ejecuta acción ni tirada. `start_session`, que ocurre antes de crear el registro de sesión, usa un registro global idempotente por petición. Este orden evita duplicar partidas o consumir dos veces un dado si se perdió la respuesta de red.

Una lectura (`list_adventures`, `get_session`, `get_operation_status`) no incrementa revisión. Una mutación confirmada incrementa `revision` una vez y persiste resultado, historial y clave juntos. `view_revision` ordena además cambios de vista como arte listo, que no cuentan como decisiones de juego. Una aclaración, error de validación, reintento duplicado o conflicto no cambia `revision`. La pausa y reanudación del host cambian conversation.paused sin incrementar la revisión del motor ni añadir escena. Ese control se publica en la instantánea SSE; al reanudar se sincroniza el turno actual y su historial. Las instantáneas conservan revision y view_revision; la TV descarta revisiones de juego inferiores y acepta el mismo número para controles de pausa. El arte procedural actual está disponible de inmediato; una actualización visual asíncrona es una ampliación del contrato.

## Seguridad y estado

El motor y el servicio de aventuras son los únicos que leen o mutan el registro privado. MCP publica exclusivamente contratos validados. El host LLM interpreta lenguaje natural contra la vista pública y devuelve una propuesta tipada; el servicio vuelve a validar IDs, revisión, condiciones y pertenencia antes de ejecutar. El RNG del servidor decide las tiradas. El servicio persiste cada mutación junto a su respuesta idempotente y conserva la plantilla/idioma de la sesión para poder rehidratarla tras reiniciar.

El endpoint canónico es `/mcp`, con Streamable HTTP sin estado de transporte; `/mcp/legacy` queda solo para compatibilidad con la demo anterior. El cliente del host debe inicializar MCP y descubrir herramientas mediante `tools/list`, no codificar una segunda implementación local del juego. El probe de desarrollo está separado del navegador y prueba esta frontera real.

`prepare_adventure` no marca una aventura lista si el único trabajo hecho fue redactar texto. La salida del generador pasa `AdventureDefinitionSchema`, validación referencial y comprobación de rutas jugables antes de registrarse o exponerse. La generación real con el modelo local se documenta por separado de las pruebas deterministas con proveedor falso.
