# Arquitectura de RPG Night v2

Este documento describe los límites entre conversación, juego y presentación para RPG Night v2. Los contratos ejecutables viven en `shared/`; la implementación actual se comprueba con pruebas automatizadas y probes locales con Ollama.

```text
Micrófono o texto
       ↓
Interfaz web ──HTTP──→ host conversacional
                         │  LLM local/proveedor elegido
                         │  interpreta intención; no posee el estado
                         ↓
                    cliente MCP oficial
                         ↓ Streamable HTTP
                    servidor MCP
                         ↓
           motor de aventura + almacenamiento v2
                   │                   │
          preparación validada     proyección pública
                                      ├─ SSE → TV
                                      └─ eventos jugados → cómic
```

El host ejecuta `initialize`, `tools/list` y `tools/call` mediante el cliente MCP oficial. No llama directamente al motor ni usa REST de juego como sustituto de MCP. La interfaz usa el host para todos los turnos, incluidos los botones de opciones. Una integración futura puede sustituir el host por Alexa+; el simulador no se presenta como una integración publicada de Alexa+.

El botón **Open shared screen** abre la web con `?host=<conversation_id>`. Esa vista muestra el turno actual y los paneles públicos ya jugados, se actualiza por `GET /api/host/conversations/:id/events` (SSE) y permite descargar PNG/SVG o imprimir como PDF. El arte atmosférico procedural se obtiene sólo para revisiones ya públicas y se integra en el cómic. Los snapshots viejos no reemplazan uno con una revisión superior. La pantalla no muestra el transcript privado del grupo, los secretos del GM ni la aventura no recorrida.

## Autoridad y datos

- `AdventureDefinition` es una plantilla versionada e inmutable. Incluye contenido público, secretos, condiciones, efectos y caminos; solo servicios del servidor pueden leerla completa.
- La partida privada guarda ID, versión y locale de aventura, nodo, variables acotadas, inventario, fase, historial, pendiente de comprobación y claves/resultados idempotentes; el locale persistido permite recuperar la definición correcta aunque las traducciones compartan IDs.
- El registro privado de operaciones conserva propietario, clave de petición, huella, plazo, estado y resultado terminal. La proyección pública excluye el propietario y detalles internos.
- `PublicTurn` se construye por proyección explícita. Solo contiene la escena revelada, opciones actuales, objetos revelados y eventos ya resueltos. Nunca serializa secretos, nodos futuros, variables privadas ni el grafo completo.
- La conversación conserva un historial acotado de instantáneas `PublicTurn` (máximo 40) para la pantalla compartida y el cómic. `/api/host/conversations/:id/tv`, sus eventos SSE y la exportación `comic.svg` leen únicamente esa lista; el enlace de conversación funciona como credencial de acceso.
- El host conserva vínculo de conversación y contexto breve. El estado persistente del servidor es la fuente de verdad tras recarga o reinicio.
- Una propuesta del LLM (`InteractionProposal`) describe una intención (`choice`, `free_action` o `clarification`); no autoriza efectos. El servidor vuelve a comprobar la partida y valida el `choice_id` vigente antes de mutar.
- La narración del modelo puede resumir hechos confirmados. No puede crear objetos, opciones, tiradas, éxitos, consecuencias ni cambios de estado.

Cada nodo de escena puede declarar `affordances`: acciones contextuales permitidas con su propia ID, objetivos actuales, objetos utilizables y enfoques disponibles. Cada una referencia mediante `resolution_choice_id` una opción de la misma escena; el servidor resuelve la propuesta a efectos y transición ya escritos. El contrato permite una resolución mecánica por affordance: objetivos y enfoques solo pueden ser variantes de una misma intención, no decisiones que necesiten consecuencias distintas. El host las proyecta únicamente para la escena actual y cuando la opción de resolución está habilitada. Los objetos anunciados como utilizables se limitan al inventario real. Una acción libre se envía como `affordance_id` y, si aplica, `target_id`, `item_id` y `approach_id`, junto a las palabras originales. El modelo no elige una opción de resolución, un nodo destino ni propone efectos. El motor verifica todas las IDs y condiciones al aplicar la acción, y conserva las selecciones en el historial privado.

## Contratos y estados

`PublicTurnSchema` fija la versión 2 del DTO y define `locale`, `PublicCheck`, `PublicOutcome`, `PublicItem` y las `affordances` vigentes. El idioma es metadata pública para que el host pueda reanudar una sesión y seleccionar voz/texto coherentes sin inferirlo de la narración. La aventura define dos o tres opciones por escena; el turno público solo expone las permitidas por condiciones actuales, así que puede presentar una sola. La validación dinámica deberá comprobar que todo estado alcanzable conserva al menos una elección ejecutable. `revision` ordena mutaciones del juego; `view_revision` ordena cambios de proyección, incluida la llegada de arte que no cambia la historia. Las fases son:

| Fase | Significado | Entrada aceptada |
| --- | --- | --- |
| `awaiting_choice` | Hay escena revelada y al menos una acción autorizada por el estado. | Acción contextual, opción actual o lectura. |
| `awaiting_check` | Hay una comprobación creada por el servidor. | Resolver esa comprobación concreta. |
| `busy` | Una operación tiene trabajo en curso. | Consultar el estado de operación; no decidir otro turno en esa partida. |
| `paused` | El host dejó de escuchar/reproducir y el estado quedó conservado. | Solo reanudación o lectura. |
| `ended` | Se confirmó un final escrito o el grupo cerró explícitamente la partida. | Lectura/exportación del historial; no hay otra acción de juego. |

Una aclaración es respuesta del host, no una fase ni una mutación: conserva turno, revisión y estado. Un error tiene resultado discriminado con código y `retryable`; un conflicto puede incluir la revisión actual. Las operaciones lentas usan `PublicOperation` con estado `pending`, `ready` o `failed`, ID, plazo y resultado público; una operación fallida no deja la partida bloqueada en `busy`.

`end_session` cierra la partida en la escena actual, elimina una comprobación pendiente sin consumir el dado y registra un cierre distinto de un desenlace narrativo. No crea una escena de final artificial. Un desenlace escrito conserva la elección que llevó al nodo `ending`. Antes de proyectar, el motor verifica el ID/versión de aventura, el nodo compatible con la fase, variables declaradas y acotadas, inventario conocido y coherencia de la comprobación pendiente.

## Revisión y concurrencia

Cada mutación de partida exige `expected_revision` y `request_id`. Una lectura no incrementa revisión. Una acción, resolución de comprobación, cierre, pausa o reanudación confirmados incrementan `revision` una sola vez. `view_revision` avanza por cada cambio de proyección, incluido arte asíncrono, sin afectar `expected_revision`. Una TV ordena por `view_revision` y rechaza eventos viejos; el motor ordena decisiones por `revision`.

El orden de validación es obligatorio:

1. Buscar `request_id` en el registro idempotente de la partida.
2. Si ya existe con mismo comando y huella de entrada, devolver exactamente el resultado guardado, aunque `expected_revision` ahora sea antiguo.
3. Si la clave existe con otra huella o comando, devolver `IDEMPOTENCY_KEY_REUSED` sin mutar.
4. Solo para una clave nueva, comparar `expected_revision`. Si está obsoleta, devolver `REVISION_CONFLICT` con la revisión actual y no ejecutar el comando.
5. Reservar una operación lenta, ejecutar, volver a validar la revisión y confirmar efecto, evento y resultado idempotente como una unidad.

Las claves de reintento se mantienen estables para el mismo acto humano; un acto nuevo usa otra clave. `start_session` se deduplica por petición en un registro global para no crear dos partidas antes de que exista la sesión. Una respuesta tardía de generación no puede modificar estado si la revisión reservada ya cambió. La interpretación del turno ocurre en el host antes de llamar a una herramienta mutante.

Al reiniciar, los trabajos sin commit se marcan `failed` recuperable; no quedan `pending` para siempre. La cancelación solo se acepta antes del commit y termina con error `CANCELLED`. Si el commit ya ocurrió, se devuelve el resultado terminal existente.

## Pausa y reanudación

La pausa detiene captura de voz y reproducción, no cancela ni repite una decisión del jugador. Se guarda `resume_phase` (`awaiting_choice` o `awaiting_check`) y se expone `phase: paused` sin opciones accionables. Reanudar restaura esa fase, consulta el estado del servidor y puede presentar una recapitulación derivada del historial confirmado; no elige por los jugadores. Recarga de navegador y reinicio del host conservan la partida por `session_id`; ninguna voz se usa para identificar jugadores.

## Persistencia compatible

El JSON actual se trata como formato heredado v1. Se conserva y no se transforma en el sitio. Las partidas nuevas v2 se guardan en un espacio versionado separado, con `schema_version: 2`, ID/versión de aventura y registros idempotentes. El lector identifica v1 para responder `UNSUPPORTED_SESSION_VERSION` o permitir una exportación/continuación en el modo legado explícitamente implementado; no inventa una migración. La conversión solo podrá añadirse como tarea futura con conversor probado, copia recuperable y compatibilidad declarada.

## Alcance del validador de F2

`validateAdventureDefinition` valida esquema, IDs y referencias, salidas, DAG, nodos alcanzables, finales estructuralmente alcanzables y referencias/bounds evidentes de condiciones/efectos. No simula todas las combinaciones arbitrarias de inventario y variables. El motor ejecuta efectos y comprobaciones con RNG inyectable; las suites recorren los estados alcanzables de las aventuras inglesa y española, y el probe real completó rutas de host/generación. La evaluación narrativa del modelo y la generación en español siguen fuera de esa cobertura.
