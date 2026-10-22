# Aventura de referencia: La campana bajo Elderglen

Las versiones `adventures/elderglen.en.json` y `adventures/elderglen.es.json` comparten el grafo y todos los IDs de contenido; solo cambian los textos de presentación. Cada ejecución dura unos 15 minutos, admite de uno a cuatro jugadores y no contiene violencia gráfica ni daño a menores. Las reglas y los efectos son datos del servidor. La narración del host no puede revelar secretos futuros ni inventar resultados.

## Mapa y rutas

```text
arrival
 ├─ visit-green → green ─┬─ ask-warden → lantern-room ─┐
 │                       └─ offer-ferry-help → ferry ──┤
 └─ follow-bank → bank ──┬─ search-marks → archives    │
                         │      ├─ take-key ────────────┘
                         │      └─ leave-record → ferry │
                         └─ hail-oren → ferry           │
ferry ─ ask-oren → bell-tower; search-shed → lantern-room (glass-prism)
lantern-room ─ light-lantern (requiere brass-key) ──────┐
              └─ carry-message ─────────────────────────┤
bell-tower ─ test-lever (d20, CD 11) ───────────────────┤
            ├─ align-prism (consume prism; d20, CD 9) ──┤
            └─ descend-to-gate ─────────────────────────┘
gate ─ ring-warning → ending-warning
     └─ open-spillway → ending-marsh
```

El camino social pasa por Elin, acumula confianza y puede llegar a la torre sin recorrer el archivo. La exploración de la orilla puede encontrar la llave y llevarla a la sala de la linterna. La ruta del ferry permite buscar el prisma; en la torre se puede alinear y consumir para reducir la dificultad de la prueba de 11 a 9. Todos los caminos convergen en la elección del aliviadero. Las pruebas d20 llegan a `gate` tanto con éxito como con contratiempo; solo cambia `bell-signal`, nunca se bloquea la decisión final. En `gate`, tocar la campana lleva al final de aviso y abrir el aliviadero al final del marjal. Son decisiones distintas con consecuencias públicas distintas.

`light-lantern` exige `brass-key`, lo consume y fija `lantern-lit = 1`. `take-key` obtiene la llave; `search-shed` obtiene el prisma. Los efectos están en choices y transiciones de la definición, no en la respuesta del modelo. Las variables actuales (`trust`, `lantern-lit`, `bell-signal`) tienen rangos acotados y valores iniciales declarados.

Las affordances publican IDs permitidos para una intención mecánica concreta, objetivos, objetos y enfoques. Cada una apunta con `resolution_choice_id` a una opción de la escena; propuestas con consecuencias distintas tienen affordances y choices distintas. Por ejemplo, buscar el cobertizo se resuelve mediante `search-ferry-shed` → `search-shed` y obtiene el prisma; usarlo después se resuelve mediante `align-prism-with-lever` → `align-prism`, consume el prisma y usa una dificultad menor. El motor valida IDs e inventario y aplica solamente los efectos y transiciones de la choice. El host no produce destinos ni efectos.

## Revelaciones y secretos

El campo `secrets` es material privado para conducción, no contenido que se serialice en la vista pública. Se revela solo cuando el grupo obtiene la pista correspondiente en esa escena.

| Nodo | Puede narrarse al llegar | Secreto reservado hasta descubrir la pista |
| --- | --- | --- |
| `arrival` | El agua supera marcas visibles y la campana no suena. | La causa es el mecanismo atascado de la linterna, no una campana rota. |
| `green` | Vecinos y guardiana discrepan entre aviso y desvío. | Elin apoya mejor un plan cuando se escuchan primero las preocupaciones del pueblo. |
| `bank` | Arañazos recientes llegan a unos escalones; hay un ferry. | Los arañazos señalan el archivo de crecidas. |
| `archives` | El archivo contiene mapas, registros y una llave junto a un dibujo. | La llave abre la linterna; el prisma está en el cobertizo. |
| `ferry` | Oren ofrece un cruce; el cobertizo empieza a inundarse. | En el cobertizo hay un prisma que amplifica la señal. |
| `lantern-room` | Hay una linterna con mecanismo inmóvil y una ventana hacia el valle. | La llave la enciende; el prisma lleva la luz más lejos. |
| `bell-tower` | La palanca está dura y se ve el pueblo bajo la lluvia. | Un contratiempo no bloquea la elección del aliviadero. |
| `gate` | Se puede avisar al pueblo o desviar agua al marjal. | El marjal absorbe esta crecida y tendrá que recuperarse durante la temporada. |
| `ending-warning` | El pueblo se organiza para llegar a terreno alto. | Los registros servirán de guía futura. |
| `ending-marsh` | Las casas quedan secas y comienza la reparación comunitaria. | La pasarela antigua deberá reconstruirse. |

## Evaluación conversacional sintética

`tests/fixtures/dialogues/elderglen.en.json` y `elderglen.es.json` describen escenarios equivalentes para ordinal, paráfrasis, acción libre, ambigüedad, lectura, pausa/reanudación, uso de objeto y ambos finales. Sus criterios evalúan intención, herramienta, IDs y estado esperado, no una redacción fija. El escenario de reanudación parte de estado persistido: el resumen debe reconstruirse desde la lectura actual y no repetir una decisión.

Estos diálogos son fixtures de evaluación, no evidencia de calidad de un modelo. La validación F2 comprueba forma, referencias, ciclos y alcance estructural; recorrer condiciones/efectos de manera ejecutable y verificar las rutas en el motor corresponde a F4. En particular, el validador estructural no demuestra por sí solo que cada opción condicionada esté disponible en cada estado.
