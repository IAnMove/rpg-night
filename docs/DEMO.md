# Demo de RPG Night: ensayo y grabación

Objetivo: vídeo de **2:40–2:55** que muestre un recorrido conversacional, su pantalla compartida y su cómic. Ruta: **experiencia Alexa+ simulada en navegador**. Revisar acceso y candidatura en [ENTREGA-JAM.md](ENTREGA-JAM.md).

## Preparar el equipo

1. Seguir el README desde `codex/complete-mvp`, arrancar Ollama con el modelo indicado y ejecutar `npm run dev`.
2. Usar Chrome/Edge en localhost o HTTPS si se quiere micrófono. En LAN HTTP funcionan texto y botones.
3. Abrir una ventana de 1920×1080, seleccionar ES/EN, escribir nombres sintéticos y pulsar **Jugar con el máster local**.
4. Elegir por título una aventura escrita que ofrezca el catálogo: «Elegimos La campana bajo Elderglen para Ana y Luis». Usar siempre el título que aparezca.
5. Activar narración si se ha comprobado la voz del equipo. Abrir **Pantalla compartida** y grabarla junto al controlador o en otra toma del mismo juego.
6. Ensayar hasta un final, incluyendo **Tirar d20** si aparece, y comprobar SVG/PDF. Éxito y contratiempo son resultados válidos; no fingir una tirada.

Mantener Ollama en marcha y cerrar notificaciones/datos personales. Usar audio propio y material que se tenga derecho a publicar.

## Guion

| Tiempo | Imagen / acción real | Narración sugerida |
| --- | --- | --- |
| 0:00–0:15 | Landing y grupo ante la pantalla. | «Una noche de rol que termina en un cómic de la historia que habéis construido juntos.» |
| 0:15–0:40 | Entrar al máster, ver catálogo y elegir. | «Esta es nuestra simulación web de una experiencia Alexa+. Un modelo local interpreta al grupo y usa herramientas MCP reales.» |
| 0:40–1:15 | Proponer una acción, elegir y resolver un d20 pendiente. | «El motor conserva las consecuencias y decide las tiradas. El modelo no puede inventar cambios de estado.» |
| 1:15–1:40 | TV de la misma sesión y sus viñetas. | «La pantalla sigue los hechos públicos de la partida. El ambiente se ilustra con SVG procedural.» |
| 1:40–2:10 | Completar la ruta ensayada, mostrar FIN y exportación. | «Nos llevamos un cómic con las decisiones y el desenlace. La historia se conserva al reiniciar.» |
| 2:10–2:35 | Pedir otra historia y mostrar preparación pendiente/lista. | «Podemos pedir una aventura nueva. Se genera localmente, se valida y sólo empieza cuando la elegimos.» |
| 2:35–2:50 | Diagrama breve y enlace de rama. | «Navegador, host Ollama, SDK MCP oficial, motor autoritativo y pantalla compartida; todo ejecutable localmente.» |

Si la generación tarda más que la toma disponible, usar una toma previa real y señalar cualquier aceleración. No atribuir tiempos falsos ni presentar la historia escrita como una generación en directo. El cómic del modo clásico pertenece a otro flujo.

## Captura

- Con OBS: ventana del navegador, audio del sistema para narración y micrófono para explicación. Grabar y escuchar una prueba corta.
- Se pueden montar fragmentos del mismo recorrido; mantener visibles opciones y resultado del dado.
- Para filmar una TV con móvil: apoyar el móvil, bloquear enfoque y evitar reflejos. Esta vía no necesita un Echo.
- Exportar a 1080p, comprobar texto/sonido y mantener duración inferior a tres minutos. Publicar en YouTube/Vimeo y probar el enlace sin sesión iniciada.

## Recuperación

- Modelo apagado: arrancar Ollama, comprobar `ollama list` y volver a abrir el host. Una acción confirmada por MCP no depende de una segunda inferencia para narrarse.
- Generación fallida: mostrar el aviso y elegir una historia escrita; no fingir contenido generado.
- Conflicto entre controladores: se recupera la vista actual sin repetir la acción; elegir de nuevo desde esa revisión.
- Micrófono ausente: escribir el mismo texto. Mantener clara la etiqueta de simulación.
- Repositorio privado: comprobar acceso de jueces antes de entregar; un push no lo hace público.

## Asistencia de desarrollo

Codex/Luna y Grok ayudaron en implementación y revisión. Grok agotó saldo HTTP 402 en una corrección; el trabajo restante se completó sin comprar saldo. Evidencias y límites: [review.md](review.md).
