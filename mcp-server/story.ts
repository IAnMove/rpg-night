import type { Choice, Language, Scene, Session, World } from '../shared/types.js';

type Chapter = { title: string; text: string; choices: [string, string, string] };
type Adventure = { title: string; item: string; chapters: Chapter[]; ending: string; endingTitle: string };
const adventures: Record<Language, Record<World, Adventure>> = {
  en: {
    fantasy: {
      title: 'The Last Light of Elderglen', item: 'Moonstone shard', endingTitle: 'A light worth keeping',
      ending: 'The moonstone settles into the lighthouse crown. Across Elderglen, a thousand windows answer with golden light. The keeper carves your names above the door: when the night was longest, you brought the dawn.',
      chapters: [
        { title: 'The forest is listening', text: 'The last lighthouse in Elderglen has gone dark. You reach a silver forest where a tiny fox carries a lantern in its teeth. Beyond the trees, something enormous stirs beneath the old observatory.', choices: ['Follow the lantern fox', 'Cross the broken bridge', 'Ask the ancient tree for help'] },
        { title: 'The bridge of forgotten names', text: 'A bridge floats over a river of stars. Its guardian, a moss-covered knight, asks for a memory instead of a toll. A silver feather hangs from his empty helmet.', choices: ['Trade a happy memory', 'Leap across the missing stones', 'Offer to carry the knight’s message'] },
        { title: 'A market under the moon', text: 'Behind a waterfall, night merchants sell bottled weather and second chances. A cartographer recognizes the mark on your map. She knows a hidden way into the observatory, but the shadow collector is watching.', choices: ['Help the cartographer close her stall', 'Steal past the shadow collector', 'Trade a song for a secret map'] },
        { title: 'The sleeping constellation', text: 'Inside the observatory, a dragon made of constellations sleeps around the stolen moonstone. It is keeping the light safe from a storm it can hear coming. The lighthouse bell trembles in the distance.', choices: ['Promise to shelter the dragon', 'Climb the moving constellation', 'Play the lighthouse melody'] },
        { title: 'Before the first dawn', text: 'You reach the lighthouse as a sea of shadows rises below. The crown has room for the moonstone, and for one last promise. The fox sets down its lantern and looks to you.', choices: ['Share the light with the forest', 'Raise the stone into the storm', 'Invite every lost traveler inside'] },
      ],
    },
    space: {
      title: 'The Signal Beyond Saturn', item: 'Stellar prism', endingTitle: 'We were never alone',
      ending: 'The stellar prism opens a passage through the rings. Your ship carries the lost travelers home, and the mysterious signal becomes a chorus of thank-yous. You leave a beacon behind, so no one has to drift alone again.',
      chapters: [
        { title: 'A voice in the static', text: 'Beyond Saturn, your little salvage ship catches a signal older than Earth’s first cities. A dark station flickers awake inside the rings. Three soft knocks echo through the hull.', choices: ['Answer the signal', 'Fly through the debris field', 'Send a friendly probe'] },
        { title: 'The station that remembers', text: 'The airlock opens onto a garden of glass. An old maintenance robot introduces itself as the captain and asks if the rescue has finally arrived. A star map glows inside its chest.', choices: ['Repair the lonely robot', 'Override the station’s sealed doors', 'Study the star map together'] },
        { title: 'A city inside a snowflake', text: 'A crystal holds an entire miniature civilization in suspended time. Its inhabitants have been sending the signal for centuries. A power surge begins to fracture their tiny sky.', choices: ['Reroute the ship’s power', 'Catch the falling reactor core', 'Ask the robot for a safer route'] },
        { title: 'Across the silent ring', text: 'The escape route crosses a ring of sleeping spacecraft. Your engine wakes an ancient sentinel, and it mistakes your rescue for an invasion. Its lights turn from blue to amber.', choices: ['Transmit the travelers’ story', 'Race past the sentinel', 'Return the sentinel’s lost insignia'] },
        { title: 'One light-year from home', text: 'The portal is almost open, but the stellar prism needs a pilot’s final command. The rescued city flickers across your viewscreen. Home is suddenly much bigger than it used to be.', choices: ['Guide the city through first', 'Jump through the unstable portal', 'Build a beacon for future travelers'] },
      ],
    },
    mystery: {
      title: 'Midnight at the Glass Hotel', item: 'Clockwork key', endingTitle: 'The thirteenth chime',
      ending: 'The clock strikes thirteen, then finally falls silent. The missing guests step out of the mirrors, carrying stories from borrowed years. As morning reaches the glass hotel, the concierge writes one last entry: mystery solved, everyone home.',
      chapters: [
        { title: 'A room that does not exist', text: 'At midnight, every guest in the Glass Hotel receives a key to room thirteen. The trouble is, the hotel has only twelve rooms. A gramophone in the empty lobby begins playing your favorite song.', choices: ['Question the night concierge', 'Follow the figure in the mirror', 'Examine the impossible key'] },
        { title: 'The guest in yesterday’s coat', text: 'An elderly guest remembers checking in tomorrow. His photograph shows the same lobby a hundred years ago. He slips you a note: never let the clock finish its song.', choices: ['Listen to the guest’s story', 'Race the turning staircase', 'Compare the old photograph'] },
        { title: 'The ballroom behind the wall', text: 'A hidden ballroom is full of dancers who cast no reflections. At the center, a clockwork musician repeats the same twelve notes. One dancer remembers the missing thirteenth note.', choices: ['Ask the dancer to teach the melody', 'Sneak past the clockwork musician', 'Find the musician’s missing score'] },
        { title: 'A bargain with borrowed time', text: 'The keeper of the clock admits that the hotel traps moments to keep its guests young. The missing guests are still inside the mirrors. One small clockwork key could release them all.', choices: ['Persuade the keeper to let go', 'Take the key before the clock chimes', 'Offer the keeper a new beginning'] },
        { title: 'The last minute of midnight', text: 'All the hotel mirrors turn toward you. The clockwork key fits the grand clock, but its hands spin faster with every breath. The guests join you for one final decision.', choices: ['Play the forgotten thirteenth note', 'Turn the key against the clock', 'Ask every guest to share a memory'] },
      ],
    },
  },
  es: {
    fantasy: {
      title: 'La última luz de Elderglen', item: 'Fragmento de piedra lunar', endingTitle: 'Una luz que merece quedarse',
      ending: 'La piedra lunar encaja en la corona del faro. En todo Elderglen, mil ventanas responden con luz dorada. La guardiana graba vuestros nombres en la puerta: cuando la noche era más larga, trajisteis el amanecer.',
      chapters: [
        { title: 'El bosque escucha', text: 'El último faro de Elderglen se ha apagado. Llegáis a un bosque plateado donde un pequeño zorro lleva un farol entre los dientes. Tras los árboles, algo enorme se mueve bajo el viejo observatorio.', choices: ['Seguir al zorro del farol', 'Cruzar el puente roto', 'Pedir ayuda al árbol ancestral'] },
        { title: 'El puente de los nombres olvidados', text: 'Un puente flota sobre un río de estrellas. Su guardián, un caballero cubierto de musgo, pide un recuerdo como peaje. Una pluma plateada cuelga de su yelmo vacío.', choices: ['Compartir un recuerdo feliz', 'Saltar entre las piedras', 'Llevar el mensaje del caballero'] },
        { title: 'Un mercado bajo la luna', text: 'Tras una cascada, los mercaderes nocturnos venden clima embotellado y segundas oportunidades. Una cartógrafa reconoce vuestra marca y conoce una entrada secreta al observatorio. Pero el recaudador de sombras vigila.', choices: ['Ayudar a la cartógrafa', 'Esquivar al recaudador de sombras', 'Cambiar una canción por un mapa'] },
        { title: 'La constelación dormida', text: 'En el observatorio, un dragón de constelaciones duerme alrededor de la piedra lunar. Protege la luz de una tormenta que se aproxima. A lo lejos tiembla la campana del faro.', choices: ['Ofrecer refugio al dragón', 'Escalar la constelación en movimiento', 'Tocar la melodía del faro'] },
        { title: 'Antes del primer amanecer', text: 'Llegáis al faro mientras un mar de sombras sube por el acantilado. En la corona caben la piedra lunar y una última promesa. El zorro deja su farol y os mira.', choices: ['Compartir la luz con el bosque', 'Alzar la piedra en la tormenta', 'Abrir el faro a los viajeros perdidos'] },
      ],
    },
    space: {
      title: 'La señal más allá de Saturno', item: 'Prisma estelar', endingTitle: 'Nunca estuvimos solos',
      ending: 'El prisma estelar abre un paso entre los anillos. Vuestra nave lleva a los viajeros a casa y la señal misteriosa se convierte en un coro de agradecimientos. Dejáis una baliza para que nadie vuelva a perderse en la oscuridad.',
      chapters: [
        { title: 'Una voz entre la estática', text: 'Más allá de Saturno, vuestra nave recibe una señal anterior a las primeras ciudades. Una estación oscura despierta entre los anillos. Tres golpes suaves resuenan en el casco.', choices: ['Responder a la señal', 'Atravesar el campo de escombros', 'Enviar una sonda amistosa'] },
        { title: 'La estación que recuerda', text: 'La esclusa se abre a un jardín de cristal. Un robot se presenta como capitán y pregunta si por fin llega el rescate. En su pecho brilla un mapa estelar.', choices: ['Reparar al robot solitario', 'Forzar las puertas selladas', 'Estudiar juntos el mapa estelar'] },
        { title: 'Una ciudad en un copo de nieve', text: 'Un cristal guarda una civilización en el tiempo. Sus habitantes llevan siglos enviando la señal. Una sobrecarga comienza a agrietar su pequeño cielo.', choices: ['Desviar la energía de la nave', 'Atrapar el núcleo que cae', 'Pedir al robot una ruta segura'] },
        { title: 'El anillo silencioso', text: 'La salida cruza un anillo de naves dormidas. Vuestro motor despierta a un centinela que confunde el rescate con una invasión. Sus luces pasan del azul al ámbar.', choices: ['Transmitir la historia de los viajeros', 'Escapar del centinela a toda velocidad', 'Devolver su insignia perdida'] },
        { title: 'A un año luz de casa', text: 'El portal casi está abierto, pero el prisma necesita una última orden. La ciudad rescatada aparece en la pantalla. De pronto, el hogar es mucho más grande.', choices: ['Guiar primero a la ciudad', 'Saltar por el portal inestable', 'Construir una baliza para otros viajeros'] },
      ],
    },
    mystery: {
      title: 'Medianoche en el Hotel de Cristal', item: 'Llave de relojería', endingTitle: 'La decimotercera campanada',
      ending: 'El reloj da trece campanadas y al fin calla. Los huéspedes salen de los espejos con historias de años prestados. Al amanecer, el conserje escribe: misterio resuelto, todos en casa.',
      chapters: [
        { title: 'Una habitación imposible', text: 'A medianoche, todos reciben una llave de la habitación trece. El problema es que el Hotel de Cristal solo tiene doce. En el vestíbulo vacío, un gramófono toca vuestra canción favorita.', choices: ['Hablar con el conserje', 'Seguir la figura del espejo', 'Examinar la llave imposible'] },
        { title: 'El huésped del abrigo de ayer', text: 'Un anciano recuerda haber llegado mañana. En su foto, el vestíbulo aparece hace cien años. Os entrega una nota: no dejéis que el reloj termine su canción.', choices: ['Escuchar la historia del huésped', 'Correr por la escalera giratoria', 'Comparar la fotografía antigua'] },
        { title: 'El baile tras la pared', text: 'Un salón oculto está lleno de bailarines sin reflejo. En el centro, un músico mecánico repite doce notas. Una bailarina recuerda la decimotercera.', choices: ['Aprender la melodía de la bailarina', 'Pasar sin despertar al músico', 'Buscar la partitura perdida'] },
        { title: 'Un pacto con el tiempo', text: 'El guardián confiesa que el hotel atrapa momentos para conservar la juventud. Los huéspedes perdidos siguen dentro de los espejos. Una pequeña llave puede liberarlos.', choices: ['Convencer al guardián', 'Tomar la llave antes de la campanada', 'Ofrecerle un nuevo comienzo'] },
        { title: 'El último minuto de medianoche', text: 'Todos los espejos se vuelven hacia vosotros. La llave encaja en el gran reloj, pero sus agujas giran cada vez más deprisa. Los huéspedes esperan vuestra última decisión.', choices: ['Tocar la nota olvidada', 'Girar la llave contra el reloj', 'Compartir los recuerdos de los huéspedes'] },
      ],
    },
  },
};

export function adventureTitle(world: World, language: Language): string { return adventures[language][world].title; }
export function questItem(world: World, language: Language): string { return adventures[language][world].item; }

export function demoScene(session: Session, action?: string, success?: boolean, forceEnd = false, choiceIndex = 0): Omit<Scene, 'id' | 'imageUrl'> {
  const a = adventures[session.language][session.world];
  const index = session.scenes.length;
  const isEnding = forceEnd || index >= a.chapters.length;
  const chapter = a.chapters[Math.min(index, a.chapters.length - 1)];
  const es = session.language === 'es';
  let consequence = '';
  if (action) {
    if (success === false) consequence = es ? 'El intento se complica: perdéis tiempo y el peligro se acerca, pero encontráis otro camino.' : 'The attempt goes awry: you lose precious time as danger draws closer, but discover another way forward.';
    else if (success === true) consequence = es ? 'Vuestra audacia da resultado: ganáis una pista y avanzáis antes que el peligro.' : 'Your daring pays off: you gain a clue and move one step ahead of the danger.';
    else consequence = choiceIndex === 2 ? (es ? 'La ayuda que ofrecéis os gana un aliado y un camino seguro.' : 'The help you offer earns an ally and a safe passage.') : (es ? 'La confianza que compartís abre un camino que antes estaba oculto.' : 'The trust you share opens a path that was hidden before.');
  }
  const setbacks = session.scenes.filter(s => s.outcome === 'setback').length + (success === false ? 1 : 0);
  const endingNote = setbacks > 0 ? (es ? ` Tras superar ${setbacks} contratiempos, vuestra historia se recordará por la perseverancia.` : ` After overcoming ${setbacks} setbacks, your story will be remembered for its perseverance.`) : (es ? ' Vuestros nuevos aliados celebran una aventura guiada por la confianza.' : ' Your new allies celebrate an adventure guided by trust.');
  const choices: Choice[] = isEnding ? [] : chapter.choices.map((text, i) => ({ id: `chapter-${index + 1}-${i}`, text, risky: i === 1 }));
  return {
    number: index + 1, title: isEnding ? a.endingTitle : chapter.title,
    narration: [consequence, isEnding ? a.ending + endingNote : chapter.text].filter(Boolean).join(' '),
    choices, isEnding, ...(action ? { action } : {}),
    ...(action ? { outcome: success === false ? 'setback' : success === true ? 'success' : choiceIndex === 2 ? 'ally' : 'trust' } : {}),
    imagePrompt: `${session.world} cinematic storybook illustration, ${isEnding ? a.endingTitle : chapter.title}, ${chapter.text}, ${choiceIndex === 2 ? 'friendly companion in the foreground' : 'adventurers on a winding journey'}, no lettering`,
  };
}
