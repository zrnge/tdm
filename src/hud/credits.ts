/**
 * Asset credits.
 *
 * The supplied models are CC-BY-4.0, which REQUIRES attribution. This list is
 * the in-game half of that obligation; `CREDITS.md` is the repository half.
 * Keep the two in sync — if you add an asset, add it in both places.
 */

export interface Credit {
  title: string;
  author: string;
  license: string;
  /** Where the license text lives, for the "license link" requirement. */
  licenseUrl: string;
  sourceUrl: string;
  /** What the game uses it for. */
  usedFor: string;
  /** True when the file ships with the project rather than being optional. */
  required: boolean;
}

export const CREDITS: Credit[] = [
  {
    title: 'AK74U | FREE ANIMATION.',
    author: 'BURNER (Alexander Ovelar)',
    license: 'CC-BY-4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    sourceUrl:
      'https://sketchfab.com/3d-models/ak74u-free-animation-2ab66220c48b465e9501067667965569',
    usedFor: 'First-person aim-down-sights viewmodel (arms + rifle). One instance only.',
    required: true,
  },
  {
    title: 'Warehouse FBX Model Free',
    author: 'Nicholas-3D',
    license: 'CC-BY-4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    sourceUrl:
      'https://sketchfab.com/3d-models/warehouse-fbx-model-free-daa7fd3ff88945298d00045ca40a4c03',
    usedFor: 'The level: 16.0 x 46.27 x 5.02 m warehouse interior.',
    required: true,
  },
  {
    title: 'Futuristic soldier (Free)',
    author: 'Pipo Game in My Notebook',
    license: 'CC-BY-4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    sourceUrl:
      'https://sketchfab.com/3d-models/futuristic-soldier-free-6515eed4b6114d159de3e9f452c31571',
    usedFor: 'Enemy bot character, its rifle, and its 18 animation clips.',
    required: true,
  },
  {
    title: 'Gunshot sounds (SKS recording)',
    author: 'Vincent Sevedge (uploaded by Tabasco)',
    license: 'CC-BY-3.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/3.0/',
    sourceUrl: 'https://opengameart.org/content/gunshot-sounds',
    usedFor: 'Rifle shots (public/audio/weapons/ak/shot_*). The SKS fires the same 7.62x39 round as the AK.',
    required: true,
  },
  {
    title: 'Gun reload sounds',
    author: 'SpringySpringo',
    license: 'CC0-1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    sourceUrl: 'https://opengameart.org/content/gun-reload-sounds',
    usedFor: 'Reload parts (public/audio/weapons/ak/reload_*), cut from assaultriflereload1.wav.',
    required: true,
  },
  {
    title: 'Impact Sounds',
    author: 'Kenney (www.kenney.nl)',
    license: 'CC0-1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    sourceUrl: 'https://kenney.nl/assets/impact-sounds',
    usedFor: 'Footsteps, bullet impacts, being hit and body falls (public/audio/footsteps, impacts, player, body).',
    required: true,
  },
  {
    title: 'Ultimate Guns Pack',
    author: 'Quaternius',
    license: 'CC0-1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    sourceUrl: 'https://quaternius.com/packs/ultimategunspack.html',
    usedFor: 'Third-person rifle (optional). A procedural placeholder is used until it is added.',
    required: false,
  },
  {
    title: 'Mixamo character + animations',
    author: 'Adobe Mixamo',
    license: 'Mixamo Terms of Use (free, royalty-free)',
    licenseUrl: 'https://www.mixamo.com/',
    sourceUrl: 'https://www.mixamo.com/',
    usedFor: 'Soldier character and locomotion/combat clips (optional). See docs/MIXAMO-SETUP.md.',
    required: false,
  },
];

/**
 * Builds the credits screen and returns a show/hide controller.
 *
 * Deliberately a DOM overlay rather than a 3D scene: it is text, it needs to be
 * selectable and readable, and it must work before the render loop is running.
 */
export function createCreditsScreen(): { show(): void; hide(): void; readonly visible: boolean } {
  const root = document.createElement('div');
  root.className = 'credits';
  root.style.display = 'none';

  const panel = document.createElement('div');
  panel.className = 'credits__panel';

  const title = document.createElement('h2');
  title.className = 'credits__title';
  title.textContent = 'CREDITS';

  const intro = document.createElement('p');
  intro.className = 'credits__intro';
  intro.textContent =
    'This game uses the following third-party assets. CC-BY-4.0 requires attribution, ' +
    'so the author, title and license are listed here and in CREDITS.md.';

  panel.append(title, intro);

  for (const credit of CREDITS) {
    const row = document.createElement('div');
    row.className = 'credits__row';

    const head = document.createElement('div');
    head.className = 'credits__row-head';

    const name = document.createElement('span');
    name.className = 'credits__name';
    name.textContent = credit.title;

    const badge = document.createElement('span');
    badge.className = 'credits__badge';
    badge.textContent = credit.license;
    if (!credit.required) badge.classList.add('credits__badge--optional');

    head.append(name, badge);

    const meta = document.createElement('div');
    meta.className = 'credits__meta';
    meta.textContent = `by ${credit.author} — ${credit.usedFor}`;

    const links = document.createElement('div');
    links.className = 'credits__links';

    const sourceLink = document.createElement('a');
    sourceLink.className = 'credits__link';
    sourceLink.href = credit.sourceUrl;
    sourceLink.target = '_blank';
    sourceLink.rel = 'noopener noreferrer';
    sourceLink.textContent = 'source';

    const licenseLink = document.createElement('a');
    licenseLink.className = 'credits__link';
    licenseLink.href = credit.licenseUrl;
    licenseLink.target = '_blank';
    licenseLink.rel = 'noopener noreferrer';
    licenseLink.textContent = 'license';

    links.append(sourceLink, licenseLink);
    row.append(head, meta, links);
    panel.appendChild(row);
  }

  const close = document.createElement('button');
  close.className = 'credits__close';
  close.textContent = 'CLOSE';
  panel.appendChild(close);

  root.appendChild(panel);
  document.body.appendChild(root);

  const hide = () => {
    root.style.display = 'none';
  };
  close.addEventListener('click', hide);

  return {
    get visible() {
      return root.style.display !== 'none';
    },
    show() {
      root.style.display = 'grid';
    },
    hide,
  };
}
