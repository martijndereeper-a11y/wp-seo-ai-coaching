/**
 * Script Sections — Reference sales script mapped into detectable phases.
 *
 * Each section has keyword fingerprints (Dutch) derived from the 14-slide
 * WP SEO AI sales deck and the accompanying call script.
 */

export interface ScriptSection {
  id: number;
  name: string;
  shortName: string;
  keywords: RegExp;
  position: 'early' | 'mid' | 'late';
  weight: number; // 1-3 importance for scoring
}

export const SCRIPT_SECTIONS: ScriptSection[] = [
  {
    id: 1,
    name: 'Origin Story (Mikael / Finland)',
    shortName: 'Origin',
    keywords: /mikael|finland|frustratie|robin hood|keukentafel|ontstaan|150 medewerkers|1.?400 klanten|700 in nederland|vier mensen|tech.?ondernemer/i,
    position: 'early',
    weight: 1,
  },
  {
    id: 2,
    name: 'AI Search Market Shift',
    shortName: 'AI Search',
    keywords: /ai search|92%.*long.?tail|15%.*nieuw|chatgpt.*17%|zoekgedrag.*veranderd|millennial|gen z|meerdere plekken|2[,.]5 mld|94%.*b2b|23x.*conversie/i,
    position: 'early',
    weight: 3,
  },
  {
    id: 3,
    name: 'SEO Still Matters Bridge',
    shortName: 'SEO Bridge',
    keywords: /seo.*klaar|absoluut niet|voort.*op.*fundament|technisch op orde|autoriteit.*echt|shortcuts.*werken niet|basis.*kloppen/i,
    position: 'early',
    weight: 1,
  },
  {
    id: 4,
    name: 'Current Tools Gap',
    shortName: 'Tools Gap',
    keywords: /losse tools|welke.*ken.*jij|gebruiken jullie|drie jaar geleden|inzichten.*maar geen.*actie|leercurve|semrush|ahrefs/i,
    position: 'early',
    weight: 2,
  },
  {
    id: 5,
    name: '96.55% Content Failure',
    shortName: '96.55%',
    keywords: /96[,.]55|9 van de 10|90%.*tijd|90%.*verspilt|nooit.*bezoeker|nooit.*één.*bezoeker/i,
    position: 'mid',
    weight: 2,
  },
  {
    id: 6,
    name: 'Manual Process Pain',
    shortName: 'Manual Pain',
    keywords: /3 tot 4 uur|per artikel|onderzoeken.*doelgroep|10.*20.*onderwerpen|uploaden|templates|custom.?gpt|handmatig/i,
    position: 'mid',
    weight: 2,
  },
  {
    id: 7,
    name: 'Sitemap Demo & Quality Gate',
    shortName: 'Sitemap Demo',
    keywords: /sitemap|weet je wat een sitemap|search.?x|linksonder|plaatsen.*content|niet zichtbaar.*website|google search console|onzichtbaar.*testen/i,
    position: 'mid',
    weight: 3,
  },
  {
    id: 8,
    name: 'Pling Notification Flow',
    shortName: 'Pling',
    keywords: /pling|live.*e.?mail|tractie|10.*van.*10|goedgekeurd|verplaats.*blog|afbeelding.*toevoegen|klantquote|automatisch.*verwijder/i,
    position: 'mid',
    weight: 3,
  },
  {
    id: 9,
    name: 'Topic Cluster Strategy',
    shortName: 'Clusters',
    keywords: /pillar.*page|cluster|deurtje|supporting content|funnel.*website|moneymaker|linken.*terug|autoriteit.*bouwen/i,
    position: 'mid',
    weight: 2,
  },
  {
    id: 10,
    name: 'Fisher Metaphor / First Mover',
    shortName: 'Fisher/1999',
    keywords: /1999|zalando|zero.?sum|first mover|sleepnet|hengel|visje|boot.*concurrent|één.*generatie|window.*6.*12/i,
    position: 'mid',
    weight: 2,
  },
  {
    id: 11,
    name: 'Expectation Management (Snowball)',
    shortName: 'Snowball',
    keywords: /sneeuwbal|6 tot 9 maanden|12 maanden|60%.*groei|verwachtingsmanagement|geen belofte|200 factoren|consistent|marathon/i,
    position: 'late',
    weight: 2,
  },
  {
    id: 12,
    name: 'Pricing & Close',
    shortName: 'Pricing',
    keywords: /investering.*beoordelen|pakket|starter.*basic.*pro|tarief|maandelijks|jaarlijks|contract|overeenkomst|€\s*\d|euro.*per.*maand|vanaf.*625/i,
    position: 'late',
    weight: 3,
  },
];

export const MAX_SCRIPT_SCORE = SCRIPT_SECTIONS.reduce((s, sec) => s + sec.weight, 0);
