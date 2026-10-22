# Entrega de RPG Night a la jam

Revisado el **22 de octubre de 2026**. Fecha límite oficial: **23 de octubre, 21:00 en Madrid** (12:00 PDT).

## Categoría y código

Categoría propuesta: **Alexa+ — experiencia simulada en navegador**, con host local Ollama y servidor MCP real. Las [reglas](https://amazonappdev2026.devpost.com/rules) y [FAQ](https://amazonappdev2026.devpost.com/details/faqs) aceptan la simulación y la ejecución local por los jueces; no exigen mantener un servidor público ni disponer de un Echo.

Código completo: **https://github.com/IAnMove/rpg-night/tree/codex/complete-mvp**. `main` contiene el scaffold; la clonación del README selecciona la rama completa.

**Acceso pendiente:** GitHub indica repositorio privado, MIT y sólo `IAnMove` como colaborador, sin invitaciones pendientes en la comprobación del 22 de octubre. Un enlace privado no da acceso a jueces. El propietario debe hacerlo público con su licencia o compartirlo con los revisores de las reglas: `knmeiss`, `giolaq`, `anishamalde`, `mosesroth`, `emersonsklar` y el contacto Devpost `testing@devpost.com`. Verificar aceptación y acceso a la rama. Esta revisión no modifica visibilidad ni envía invitaciones.

No seleccionar AWS Builder sólo por tener un adaptador Bedrock. No se ha ejecutado Bedrock con una cuenta AWS ni usado Kiro en esta revisión. Tampoco se afirma una aplicación Fire TV publicada.

## Descripción propuesta

> RPG Night turns a cooperative game night into an illustrated story to keep. Players speak, type or choose together while a local conversational Game Master guides them through an English or Spanish adventure. It can also prepare a short new story before the party explicitly chooses to play it.
>
> The browser simulates the intended Alexa+ experience. A local Ollama host discovers and calls eight tools on a real MCP server over Streamable HTTP. The engine validates actions and owns the choices, inventory, consequences and d20 rolls. Sessions persist across restarts, and a read-only shared screen follows the same public story live.
>
> The party downloads an illustrated SVG comic or prints a PDF. Atmospheric illustrations are original procedural SVGs, not AI-generated pictures. A classic mode works without a model; the conversational demo uses the documented local model. This submission demonstrates a browser simulation rather than a published Echo skill.

## Checklist de envío

- [ ] Probar el README y la rama completa desde otra cuenta autorizada.
- [ ] Revisar una partida hablada en el navegador elegido; LAN HTTP conserva texto/botones, mientras el micrófono necesita localhost/HTTPS.
- [ ] Leer la aventura que se mostrará y usar nombres sintéticos.
- [ ] Grabar el recorrido de [DEMO.md](DEMO.md), mantenerlo por debajo de tres minutos y revisar el vídeo exportado.
- [ ] Publicar el vídeo en YouTube o Vimeo y probar su enlace sin iniciar sesión.
- [ ] Pegar descripción, rama, vídeo y feedback; seleccionar Alexa+ simulada.
- [ ] Verificar el estado enviado en Devpost y guardar su confirmación.

No se ha verificado una candidatura enviada ni un vídeo publicado en esta revisión. Un commit no sustituye esos pasos.

## Feedback: borrador para revisar por el representante

| Herramienta | Uso y resultado observado | Fricción / propuesta concreta |
| --- | --- | --- |
| SDK TypeScript oficial de MCP | Cliente y servidor reales; negociación 2025-11-25, descubrimiento y llamadas de ocho herramientas. | Revisiones, reintentos y recuperación necesitan lógica propia. Sería útil un ejemplo pequeño de host persistente que recupere una mutación confirmada. |
| Ollama / Qwen3 4B | Interpretación de intenciones y generación de grafos con inferencia local. | El modelo pequeño puede seleccionar mal una herramienta o devolver JSON inválido; se añadieron límites, elección explícita, esquema, una reparación y narración desde el estado confirmado. |
| Documentación Alexa+ / FAQ de la jam | Se eligió la vía de simulación pública documentada. No hubo acceso al tooling de socios ni conexión con un Echo. | La FAQ advierte que algunas guías individuales omiten la restricción de acceso; enlazarla y mostrar un ejemplo de simulación desde cada guía mejoraría el inicio. |
| Web Speech del navegador | Reconocimiento opcional y narración; texto y botones completan el mismo juego. | Disponibilidad y permisos varían; HTTP de LAN no equivale a localhost/HTTPS. El producto avisa y conserva otros controles. La captura física requiere comprobación humana. |

Completar «Would you build with these devices and services again?» con **sí/no y una razón propia**. No inventar onboarding o generaciones AWS que no se hayan realizado.

El informe técnico está en [review.md](review.md); el plan persistente y las incidencias, en [PLAN-REVISION-FINAL.md](PLAN-REVISION-FINAL.md). Mostrar la sesión del host y su propio cómic, sin montar una partida clásica como si fuera la misma historia.
