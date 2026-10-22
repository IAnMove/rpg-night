import type { World } from '../shared/types.js';
import type { PublicTurn } from '../shared/session-schema.js';
export function xml(value: string): string { return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!)); }

/** Atmospheric procedural art derived solely from the scene already visible to the players. */
export function publicSceneArt(turn: PublicTurn): string {
  const visible = `${turn.scene_id} ${turn.narration}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const world: World = /\b(starship|spaceship|space|planet|orbit|galaxy|station|nave|espacio|planeta|orbita|galaxia|estacion)\b/.test(visible) ? 'space'
    : /\b(mansion|clock|mystery|detective|museum|reloj|misterio|museo)\b/.test(visible) ? 'mystery' : 'fantasy';
  let hash = 0;
  for (const char of turn.scene_id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  // Motifs describe an atmosphere, not an additional event or a model-generated literal depiction.
  const chapter = world === 'fantasy' && /\b(bridge|puente)\b/.test(visible) ? 2
    : world === 'fantasy' && /\b(market|mercado)\b/.test(visible) ? 3 : 1;
  return sceneArt(world, chapter, hash % 100);
}

/** Local, deliberately illustrated demo art. Bedrock replaces this with model output. */
export function sceneArt(world: World, chapter = 1, variant = 0): string {
  const colors = world === 'space' ? ['#070e23', '#203b60', '#84dbed', '#f8cd88'] : world === 'mystery' ? ['#091821', '#264447', '#9bcac5', '#efbd78'] : ['#0a1325', '#1e3848', '#99c7bd', '#f8d89b'];
  const [night, mist, light, gold] = colors;
  const seed = chapter * 37 + variant * 11;
  const stars = Array.from({ length: 80 }, (_, i) => `<circle cx="${(i * 137 + seed * 7) % 1600}" cy="${(i * 71 + seed * 3) % 650}" r="${i % 5 === 0 ? 2 : 1}" fill="${light}" opacity="${0.2 + (i % 5) / 8}"/>`).join('');
  const trees = (offset: number, color: string, scale: number) => Array.from({ length: 22 }, (_, i) => {
    const x = i * 94 + (seed % 31) - 200; const h = (120 + ((i * 53 + seed) % 190)) * scale;
    return `<path d="M${x} ${900-offset}v-${h}m0 0l-${h * .27} ${h*.62}h${h*.16}l-${h*.28} ${h*.3}h${h*.78}l-${h*.28}-${h*.3}h${h*.16}z" fill="${color}"/>`;
  }).join('');
  const towerX = 1040 - chapter * 24;
  let subject = '';
  if (world === 'fantasy') subject = `
    <circle cx="${1190-chapter*35}" cy="225" r="110" fill="${light}" opacity=".1" filter="url(#glow)"/>
    <circle cx="${1190-chapter*35}" cy="225" r="70" fill="${light}" opacity=".85"/><circle cx="${1165-chapter*35}" cy="207" r="66" fill="${night}"/>
    <path d="M0 670L180 350 370 590 650 280 930 580 1200 340 1600 620V900H0Z" fill="#213443"/>
    <path d="M650 280l-83 133 90-40 58 28zM1200 340l-75 106 66-29 56 23z" fill="${light}" opacity=".21"/>
    ${trees(160, '#183039', .9)}
    <path d="M700 900L805 540 1045 500 1240 900Z" fill="#152730"/>
    <path d="M${towerX-24} 545V323h48v222zM${towerX-42} 326l42-80 42 80z" fill="#0b1d2a"/>
    <path d="M${towerX-32} 332h64v45h-64z" fill="${gold}" opacity=".8"/><path d="M${towerX} 355L1550 200v300z" fill="url(#beam)"/>
    <path d="M${towerX-120} 560V440h50v120m10-8V399h48v155m55-12V420h43v140" fill="#102530"/>
    <path d="M750 900Q850 710 ${towerX} 550Q910 720 925 900Z" fill="${light}" opacity=".18"/>
    ${trees(-80, '#081923', 1.5)}
    <path d="M550 790l25-23 23 13 28-12-14 29-24 9-26-7-26 15z" fill="${gold}" opacity=".8"/>
    <circle cx="623" cy="797" r="6" fill="${gold}" filter="url(#glow)"/>`;
  if (world === 'space') subject = `
    <circle cx="1110" cy="310" r="230" fill="url(#planet)"/>
    <ellipse cx="1110" cy="310" rx="430" ry="76" transform="rotate(-24 1110 310)" fill="none" stroke="${light}" stroke-width="33" opacity=".24"/>
    <ellipse cx="1110" cy="310" rx="470" ry="88" transform="rotate(-24 1110 310)" fill="none" stroke="${gold}" stroke-width="4" opacity=".5"/>
    <path d="M0 820L160 710 370 790 600 660 880 820 1260 720 1600 810V900H0Z" fill="#101d32"/>
    <g transform="translate(${620+chapter*18} ${440-chapter*8}) rotate(-12)"><path d="M-120 100L0-130 120 100 0 60Z" fill="#304e63" stroke="${light}" stroke-width="2"/><path d="M-30 65L0-90 30 65Z" fill="#96c9cd" opacity=".6"/><path d="M-45 100L0 270 45 100Z" fill="url(#beam)"/><circle r="18" cy="-10" fill="${gold}" filter="url(#glow)"/></g>
    <g transform="translate(290 335)"><ellipse rx="125" ry="29" fill="none" stroke="${light}" stroke-width="12"/><path d="M-30-70H30V70H-30Z" fill="#35536a"/><circle r="12" fill="${gold}"/></g>`;
  if (world === 'mystery') subject = `
    <circle cx="1140" cy="210" r="77" fill="${light}" opacity=".7"/>
    <path d="M0 720L120 640h150v80h90V580h130v140h85v-90h120v90h500v-80h90v80h200v180H0Z" fill="#173238"/>
    <path d="M780 750V310h420v440zM750 310l240-160 240 160zM920 750V210h140v540" fill="#102830" stroke="#456064" stroke-width="2"/>
    <circle cx="990" cy="275" r="42" fill="#203b42" stroke="${gold}" stroke-width="3"/><path d="M990 244v31l22 17" stroke="${gold}" stroke-width="4" fill="none"/>
    ${Array.from({length: 15}, (_,i)=>`<path d="M${805+(i%5)*75} ${365+Math.floor(i/5)*106}h33v60h-33z" fill="${i%3===chapter%3 ? gold : light}" opacity="${i%3===chapter%3 ? .8 : .12}"/>`).join('')}
    <path d="M955 750V640q35-50 70 0v110" fill="${gold}" opacity=".8"/>
    <path d="M550 900L945 750h90L900 900Z" fill="${gold}" opacity=".15"/>
    <path d="M220 840V460m-40 0h80l-15-60h-50z" fill="#091a24" stroke="#4e6060" stroke-width="3"/>
    <circle cx="220" cy="437" r="15" fill="${gold}" filter="url(#glow)"/>
    ${Array.from({length: 45},(_,i)=>`<path d="M${i*39} ${(i*137)%850}l-12 40" stroke="${light}" opacity=".1"/>`).join('')}`;

  // The local comic changes setting with the plot, while retaining the same visual language.
  if (world === 'fantasy' && chapter === 2) subject = `
    <circle cx="1190" cy="190" r="67" fill="${light}" opacity=".65"/>
    <path d="M0 640L210 350 450 570 710 300 1020 560 1360 340 1600 600V900H0Z" fill="#1a3040"/>
    <path d="M760 500Q1110 670 640 900H1170Q1390 660 850 500Z" fill="#77b5b5" opacity=".23"/>
    ${Array.from({length:28},(_,i)=>`<circle cx="${760+(i*53)%380}" cy="${590+(i*43)%300}" r="${i%3+1}" fill="${light}" opacity=".6"/>`).join('')}
    <path d="M235 650Q780 180 1350 650L1280 714Q795 315 300 710Z" fill="#304751" stroke="#729495" stroke-width="3"/>
    <path d="M250 637Q780 169 1330 635" fill="none" stroke="${gold}" stroke-width="4" opacity=".5"/>
    ${Array.from({length:14},(_,i)=>`<path d="M${340+i*70} ${503-Math.sin(i/13*Math.PI)*142}v-57" stroke="#58737a" stroke-width="11"/>`).join('')}
    <path d="M417 560v-86q0-34 28-34t28 34v86z" fill="#1b2835" stroke="#728e8c" stroke-width="2"/>
    <path d="M417 485h56l-10 55-18 17-18-17z" fill="#587570"/><path d="M445 493v41m-15-23h30" stroke="${gold}" stroke-width="3"/>
    ${trees(-50, '#071722', 1.1)}`;
  if (world === 'fantasy' && chapter === 3) subject = `
    <path d="M0 0H420L540 900H0ZM1600 0H1370L1250 900H1600Z" fill="#152b37"/>
    <path d="M250 0H405L465 730H325Z" fill="${light}" opacity=".14"/><path d="M280 0l69 720m-10-720 48 720" stroke="${light}" opacity=".17" stroke-width="12"/>
    <circle cx="980" cy="185" r="80" fill="${light}" opacity=".45"/>
    <path d="M0 740Q800 610 1600 740V900H0Z" fill="#10242e"/>
    ${[530,830,1130].map((x,i)=>`<g transform="translate(${x} ${450-i%2*65})"><path d="M-125 240V65h250v175" fill="#1d3a43"/><path d="M-155 70L0-70 155 70Z" fill="${['#446d6e','#6c6149','#485c76'][i]}" stroke="${gold}" stroke-opacity=".35"/><path d="M-20-50L0-70l20 20v120h-40z" fill="${gold}" opacity=".2"/><rect x="-105" y="125" width="210" height="90" rx="5" fill="#2d4a4d"/>${[0,1,2,3,4].map(n=>`<path d="M${-80+n*40} 124v-28h18v28z" fill="${n%2 ? light : gold}" opacity=".65"/>`).join('')}</g>`).join('')}
    <path d="M410 285Q850 390 1310 280" fill="none" stroke="#859088" stroke-width="2"/>
    ${[470,650,840,1030,1220].map((x,i)=>`<g transform="translate(${x} ${320+Math.sin(i)*20})"><path d="M0 0v55" stroke="#859088"/><rect x="-12" y="40" width="24" height="34" rx="7" fill="${gold}" opacity=".75"/><circle cy="55" r="28" fill="${gold}" opacity=".16" filter="url(#glow)"/></g>`).join('')}`;
  if (world === 'fantasy' && chapter === 4) subject = `
    <path d="M130 900V390Q800-280 1470 390V900H130Z" fill="#10202f" stroke="#355364" stroke-width="8"/>
    <path d="M220 900V410Q800-130 1380 410V900" fill="none" stroke="#4c6d75" stroke-width="2"/>
    ${[360,620,980,1240].map(x=>`<path d="M${x} 900V250" stroke="#2a4455" stroke-width="6"/>`).join('')}
    <ellipse cx="800" cy="780" rx="570" ry="100" fill="#1e3a47" stroke="#658c90" stroke-width="2"/>
    <ellipse cx="800" cy="780" rx="365" ry="62" fill="none" stroke="${gold}" stroke-opacity=".4" stroke-width="2"/>
    <path d="M430 570L540 430 730 475 920 350 1095 390 1170 315 1095 260 1000 310 905 245 760 340 670 200 590 345 430 300 490 480Z" fill="${light}" opacity=".09"/>
    <path d="M430 570L540 430 730 475 920 350 1095 390 1170 315 1095 260 1000 310 905 245 760 340 670 200 590 345 430 300 490 480Z" fill="none" stroke="${light}" stroke-width="2" opacity=".65"/>
    ${[[430,570],[540,430],[730,475],[920,350],[1095,390],[1170,315],[1095,260],[1000,310],[905,245],[760,340],[670,200],[590,345],[430,300],[490,480]].map(([x,y],i)=>`<circle cx="${x}" cy="${y}" r="${i%3===0?7:4}" fill="${i%3===0?gold:light}"/>`).join('')}
    <path d="M810 600l38 62-38 62-38-62z" fill="${gold}" opacity=".9"/><circle cx="810" cy="662" r="53" fill="${gold}" opacity=".35" filter="url(#glow)"/>`;
  if (world === 'fantasy' && chapter === 5) subject += `
    <path d="M140 140l110 110-75 25 110 170M1340 80l-130 150 90-10-120 170" fill="none" stroke="${light}" stroke-width="4" opacity=".7"/>
    <ellipse cx="400" cy="50" rx="430" ry="100" fill="#0c1c2b" opacity=".7"/>`;
  if (world === 'fantasy' && chapter >= 6) subject += `
    <circle cx="700" cy="330" r="150" fill="${gold}" opacity=".12" filter="url(#glow)"/>
    <circle cx="700" cy="330" r="70" fill="${gold}" opacity=".5"/>
    ${Array.from({length:14},(_,i)=>`<path d="M${120+i*105} ${680+i%3*35}h30v25h-30z" fill="${gold}" opacity=".5"/>`).join('')}`;

  if (world === 'space' && chapter === 2) subject = `
    <ellipse cx="800" cy="440" rx="700" ry="380" fill="#0c1b30" stroke="#35556b" stroke-width="18"/>
    <ellipse cx="800" cy="410" rx="610" ry="300" fill="#17374a" stroke="${light}" stroke-opacity=".25" stroke-width="3"/>
    <path d="M200 410h1200M800 100v620M350 210l900 400M350 610l900-400" stroke="#284758" stroke-width="8"/>
    ${[340,470,1100,1240].map((x,i)=>`<path d="M${x} 790v-230m0 80q-90-100-50-150 65 25 50 150m0 40q100-150 60-190-80 75-60 190" fill="#447d85" fill-opacity=".3" stroke="${light}" stroke-opacity=".4" stroke-width="3"/>`).join('')}
    <g transform="translate(820 580)"><rect x="-95" y="-150" width="190" height="125" rx="35" fill="#46677c" stroke="${light}" stroke-width="3"/><rect x="-70" y="-125" width="140" height="70" rx="20" fill="#132636"/><circle cx="-30" cy="-90" r="10" fill="${gold}"/><circle cx="30" cy="-90" r="10" fill="${gold}"/><path d="M-60-5h120l25 140H-85z" fill="#304f64"/><circle cy="60" r="24" fill="${light}" opacity=".5"/><path d="M-85 20l-50 100M85 20l50 100M-40 135v70M40 135v70" stroke="#527c8f" stroke-width="22"/></g>`;
  if (world === 'space' && chapter === 3) subject = `
    <circle cx="1230" cy="240" r="125" fill="url(#planet)"/>
    <path d="M800 100L1080 330 1020 680 800 840 570 680 510 330Z" fill="#498da2" fill-opacity=".19" stroke="${light}" stroke-width="3"/>
    <path d="M800 100L680 350 800 840 925 350Z" fill="${light}" opacity=".1"/>
    <path d="M510 330l290 110 280-110M570 680l230-240 220 240M800 100v340" fill="none" stroke="${light}" opacity=".45" stroke-width="2"/>
    ${Array.from({length:13},(_,i)=>`<path d="M${620+i*28} 620v-${40+(i*47)%150}h19v${40+(i*47)%150}z" fill="${i%3===0?gold:light}" opacity=".55"/>`).join('')}
    <ellipse cx="800" cy="640" rx="210" ry="34" fill="${light}" opacity=".22"/>
    <path d="M720 160l110 100-70 40 140 110M1010 660l-90-60 60-60-110-80" fill="none" stroke="${gold}" stroke-width="3"/>
    <circle cx="800" cy="500" r="220" fill="${light}" opacity=".06" filter="url(#glow)"/>`;
  if (world === 'space' && chapter === 4) subject = `
    <circle cx="1000" cy="380" r="255" fill="#172f44" stroke="#486c7d" stroke-width="15"/>
    <circle cx="1000" cy="380" r="180" fill="#0c1c30" stroke="${light}" stroke-width="3"/>
    <circle cx="1000" cy="380" r="100" fill="${gold}" opacity=".12"/>
    <path d="M900 380l100-65 100 65-100 65z" fill="${gold}" opacity=".8"/>
    ${[0,1,2,3,4,5].map(i=>`<path d="M1000 105v-70h-150v55" transform="rotate(${i*60} 1000 380)" fill="none" stroke="#416477" stroke-width="14"/>`).join('')}
    ${[250,400,550].map((x,i)=>`<path d="M${x} ${500+i*100}l-35 85 35-20 35 20z" fill="#4e798c" stroke="${light}" stroke-width="2"/>`).join('')}`;
  if (world === 'space' && chapter >= 5) subject = `
    <ellipse cx="1040" cy="420" rx="310" ry="350" fill="#14344a" stroke="${light}" stroke-width="12" opacity=".6"/>
    <ellipse cx="1040" cy="420" rx="260" ry="300" fill="#0a152b" stroke="${gold}" stroke-width="2"/>
    <ellipse cx="1040" cy="420" rx="200" ry="240" fill="url(#planet)" opacity=".4"/>
    ${Array.from({length:25},(_,i)=>`<circle cx="${820+(i*53)%440}" cy="${170+(i*87)%490}" r="2" fill="${gold}"/>`).join('')}
    <path d="M200 740L540 400 690 570 490 565 430 750Z" fill="#42647c" stroke="${light}" stroke-width="2"/><path d="M435 568l-210 200 165-30" fill="${light}" opacity=".3"/>
    ${chapter>=6 ? [0,1,2,3,4].map(i=>`<path d="M${780+i*88} ${350+i%2*100}l-15 55 30-15 20 15-10-55z" fill="${gold}" opacity=".8"/>`).join('') : ''}`;

  if (world === 'mystery' && chapter === 2) subject = `
    <path d="M0 0L600 290v360L0 900ZM1600 0l-600 290v360l600 250Z" fill="#163039"/>
    <path d="M0 900L600 650h400l600 250Z" fill="#294548"/>
    <path d="M600 290h400v360H600Z" fill="#0b1b28" stroke="#678780" stroke-width="4"/>
    <path d="M0 0L600 290h400L1600 0Z" fill="#11212e"/>
    ${[0,1,2,3,4].map(i=>`<path d="M${i*320} 900L800 650" stroke="#688c86" opacity=".25"/>`).join('')}
    <g transform="translate(400 370) rotate(-8)"><rect x="-135" y="-180" width="270" height="350" fill="#455351" stroke="${gold}" stroke-width="8"/><rect x="-112" y="-157" width="224" height="304" fill="#162b33"/><circle cy="-55" r="45" fill="#83968a" opacity=".6"/><path d="M-80 145V45Q0-25 80 45v100" fill="#68786c" opacity=".45"/></g>
    <path d="M1100 710V470q45-75 90 0v240" fill="#0c1b26"/><circle cx="1145" cy="413" r="36" fill="#29464a"/><path d="M1115 480l30 95 30-95" fill="${gold}" opacity=".45"/>
    <path d="M715 600v-65q85-90 170 0v65" fill="${gold}" opacity=".25"/>`;
  if (world === 'mystery' && chapter === 3) subject = `
    <path d="M80 780V260Q800-160 1520 260v520" fill="#142d36" stroke="#4b6b67" stroke-width="8"/>
    <ellipse cx="800" cy="800" rx="720" ry="120" fill="#345454" opacity=".5"/>
    <path d="M800 0v170M540 190Q800 330 1060 190M620 230v90M800 270v100M980 230v90" fill="none" stroke="${gold}" stroke-width="6"/>
    ${[[540,190],[620,320],[800,370],[980,320],[1060,190]].map(([x,y])=>`<circle cx="${x}" cy="${y}" r="15" fill="${gold}" opacity=".8"/><circle cx="${x}" cy="${y}" r="40" fill="${gold}" opacity=".13" filter="url(#glow)"/>`).join('')}
    ${[350,620,960,1250].map((x,i)=>`<g transform="translate(${x} ${580+i%2*35})"><circle cx="-30" cy="-40" r="22" fill="#618180"/><circle cx="30" cy="-33" r="20" fill="#809991"/><path d="M-45-15l-35 160h95L-15-15z" fill="#304c51"/><path d="M20-10l-25 160h80L45-10z" fill="#4c6e6b"/><path d="M-20 0l45 35 20-35" fill="none" stroke="${gold}" stroke-opacity=".4" stroke-width="5"/></g>`).join('')}`;
  if (world === 'mystery' && (chapter === 4 || chapter === 5)) subject = `
    <path d="M620 900V200q180-190 360 0v700" fill="#1a343b" stroke="#54766d" stroke-width="8"/>
    <circle cx="800" cy="350" r="190" fill="#0c1f2c" stroke="${gold}" stroke-width="8"/>
    <circle cx="800" cy="350" r="160" fill="none" stroke="${light}" stroke-opacity=".4" stroke-width="2"/>
    ${Array.from({length:12},(_,i)=>`<path d="M800 188v22" transform="rotate(${i*30} 800 350)" stroke="${gold}" stroke-width="5"/>`).join('')}
    <path d="M800 220v130l85 60" fill="none" stroke="${gold}" stroke-width="7"/>
    <path d="M800 540v180" stroke="${gold}" stroke-width="6"/><circle cx="800" cy="725" r="40" fill="${gold}" opacity=".65"/>
    ${[330,1210].map((x,i)=>`<g transform="translate(${x} 420)"><path d="M-100 350V-130q100-120 200 0v480z" fill="#306063" fill-opacity=".2" stroke="${light}" stroke-opacity=".5" stroke-width="4"/>${chapter===5?'<circle cy="50" r="28" fill="#9bcac5" opacity=".3"/><path d="M-35 90l-25 150H60L35 90z" fill="#9bcac5" opacity=".2"/>':''}</g>`).join('')}
    ${chapter===4 ? `<g transform="translate(430 470) rotate(-25)"><circle cy="-60" r="50" fill="none" stroke="${gold}" stroke-width="16"/><path d="M0-10v170h45v-20H10v-25h35V90H0" fill="none" stroke="${gold}" stroke-width="16"/></g>` : ''}`;
  if (world === 'mystery' && chapter >= 6) subject += `
    <circle cx="450" cy="330" r="140" fill="${gold}" opacity=".3"/>
    <path d="M280 320q20-25 40 0 20-25 40 0m-180 60q15-20 30 0 15-20 30 0" fill="none" stroke="#0a1a26" stroke-width="5"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900" role="img" aria-label="${xml(world)} storybook landscape, chapter ${chapter}"><defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="${night}"/><stop offset="1" stop-color="${mist}"/></linearGradient><linearGradient id="beam"><stop stop-color="${gold}" stop-opacity=".3"/><stop offset="1" stop-color="${gold}" stop-opacity="0"/></linearGradient><radialGradient id="planet"><stop stop-color="#819baf"/><stop offset=".7" stop-color="#3e5c7a"/><stop offset="1" stop-color="#1c2947"/></radialGradient><filter id="glow"><feGaussianBlur stdDeviation="12"/></filter><radialGradient id="vignette"><stop offset=".4" stop-color="#030811" stop-opacity="0"/><stop offset="1" stop-color="#030811" stop-opacity=".7"/></radialGradient></defs><path d="M0 0h1600v900H0z" fill="url(#sky)"/>${stars}${subject}<path d="M0 0h1600v900H0z" fill="url(#vignette)"/><g fill="#06111a"><circle cx="688" cy="755" r="12"/><path d="M676 768h24l15 61h-55zM677 819l-6 38h7l12-35 6 35h7l-5-38z"/><circle cx="734" cy="774" r="9"/><path d="M725 784h18l11 49h-39zM726 826l-5 31h7l7-27 7 27h7l-6-31z"/></g><circle cx="713" cy="790" r="5" fill="${gold}"/><circle cx="713" cy="790" r="22" fill="${gold}" opacity=".3" filter="url(#glow)"/></svg>`;
}
