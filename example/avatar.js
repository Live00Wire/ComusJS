// ==========================================
// AVATAR.JS - Profile and SVG Generation
// 
// This file manages the local player's visual identity.
// It relies entirely on HTML5 Canvas/SVG and Local Storage,
// completely independent of the ComusJS engine.
// ==========================================

const AvatarAssets = {
  skin: ['#FFD1B3', '#E2A873', '#9D5C35', '#4A2711', '#7B98FF', '#A3E4D7', '#ff9ff3', '#00d2d3'],
  shape: [
    `<circle cx="50" cy="50" r="40" fill="SKIN_COLOR" />`, 
    `<rect x="15" y="15" width="70" height="75" rx="20" fill="SKIN_COLOR" />`, 
    `<ellipse cx="50" cy="50" rx="35" ry="45" fill="SKIN_COLOR" />`, 
    `<rect x="15" y="25" width="70" height="60" rx="30" fill="SKIN_COLOR" />` 
  ],
  eyes: [
    `<circle cx="35" cy="45" r="5" fill="#000"/><circle cx="65" cy="45" r="5" fill="#000"/>`, 
    `<line x1="30" y1="45" x2="40" y2="45" stroke="#000" stroke-width="4"/><line x1="60" y1="45" x2="70" y2="45" stroke="#000" stroke-width="4"/>`, 
    `<path d="M 30 45 Q 35 35 40 45" stroke="#000" stroke-width="4" fill="transparent"/><path d="M 60 45 Q 65 35 70 45" stroke="#000" stroke-width="4" fill="transparent"/>`, 
    `<circle cx="35" cy="45" r="5" fill="#000"/><path d="M 60 45 Q 65 35 70 45" stroke="#000" stroke-width="4" fill="transparent" stroke-linecap="round"/>`, 
    `<rect x="25" y="35" width="20" height="20" rx="4" stroke="#000" stroke-width="3" fill="transparent"/><rect x="55" y="35" width="20" height="20" rx="4" stroke="#000" stroke-width="3" fill="transparent"/><line x1="45" y1="45" x2="55" y2="45" stroke="#000" stroke-width="3"/>`, 
    `<line x1="28" y1="35" x2="42" y2="42" stroke="#000" stroke-width="4" stroke-linecap="round"/><circle cx="37" cy="47" r="4" fill="#000"/><line x1="72" y1="35" x2="58" y2="42" stroke="#000" stroke-width="4" stroke-linecap="round"/><circle cx="63" cy="47" r="4" fill="#000"/>` 
  ],
  mouth: [
    `<path d="M 35 65 Q 50 80 65 65" stroke="#000" stroke-width="4" fill="transparent" stroke-linecap="round"/>`, 
    `<line x1="40" y1="70" x2="60" y2="70" stroke="#000" stroke-width="4" stroke-linecap="round"/>`, 
    `<circle cx="50" cy="70" r="6" fill="#000"/>`, 
    `<path d="M 35 65 Q 50 90 65 65 Z" fill="#000"/>`, 
    `<path d="M 35 75 Q 50 60 65 75" stroke="#000" stroke-width="4" fill="transparent" stroke-linecap="round"/>`, 
    `<path d="M 30 65 Q 50 85 70 65 Z" fill="#fff" stroke="#000" stroke-width="3"/>` 
  ],
  accessory: [
    ``, 
    `<circle cx="25" cy="55" r="8" fill="#ff7675" opacity="0.6"/><circle cx="75" cy="55" r="8" fill="#ff7675" opacity="0.6"/>`, 
    `<path d="M 12 45 Q 50 5 88 45" stroke="#ff4757" stroke-width="8" fill="transparent" stroke-linecap="round"/>`, 
    `<path d="M 75 25 Q 85 40 75 45 Q 65 40 75 25 Z" fill="#74b9ff"/>`, 
    `<g transform="rotate(-15 70 58)"><rect x="65" y="55" width="15" height="6" rx="2" fill="#ffeaa7"/><rect x="68" y="56" width="9" height="4" fill="#fdcb6e"/></g>` 
  ]
};

// Generate a random default configuration
let currentConfig = {
  shape: Math.floor(Math.random() * AvatarAssets.shape.length),
  skin: Math.floor(Math.random() * AvatarAssets.skin.length),
  eyes: Math.floor(Math.random() * AvatarAssets.eyes.length),
  mouth: Math.floor(Math.random() * AvatarAssets.mouth.length),
  accessory: Math.floor(Math.random() * AvatarAssets.accessory.length)
};

let savedName = `Player_${Math.floor(Math.random() * 9999)}`;
const savedProfileData = localStorage.getItem('comus_profile');

// Hydrate from localStorage if it exists
if (savedProfileData) {
  try {
    const parsed = JSON.parse(savedProfileData);
    Object.assign(currentConfig, parsed.avatar);
    if (parsed.name) savedName = parsed.name;
  } catch (e) {
    console.error("Failed to parse saved profile.", e);
  }
}

export function hasSavedProfile() { return !!savedProfileData; }
export function getSavedName() { return savedName; }
export function getCurrentAvatar() { return { ...currentConfig }; }

/**
 * Compiles the raw SVG string for a given avatar configuration.
 */
export function renderAvatarSVG(config) {
  const safeConfig = { shape: 0, skin: 0, eyes: 0, mouth: 0, accessory: 0, ...config };
  const skinColor = AvatarAssets.skin[safeConfig.skin];
  const baseShape = AvatarAssets.shape[safeConfig.shape].replace('SKIN_COLOR', skinColor);
  return `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100%" height="100%">
      ${baseShape}${AvatarAssets.eyes[safeConfig.eyes]}
      ${AvatarAssets.mouth[safeConfig.mouth]}${AvatarAssets.accessory[safeConfig.accessory]}
    </svg>
  `;
}

/**
 * Mounts the Avatar Creator UI to the specified DOM elements.
 */
export function setupAvatarCreator(previewEl, controlsEl) {
  function updatePreview() { previewEl.innerHTML = renderAvatarSVG(currentConfig); }
  
  function cycleFeature(feature, direction) {
    const max = AvatarAssets[feature].length;
    currentConfig[feature] = (currentConfig[feature] + direction % max + max) % max;
    updatePreview();
  }

  const features = [
    { key: 'skin', label: 'Skin Color' }, { key: 'shape', label: 'Head Shape' },
    { key: 'eyes', label: 'Eyes' }, { key: 'mouth', label: 'Mouth' },
    { key: 'accessory', label: 'Accessory' } 
  ];

  features.forEach(f => {
    const row = document.createElement('div');
    row.className = 'control-row';
    
    const leftBtn = document.createElement('button');
    leftBtn.className = 'arrow-btn';
    leftBtn.textContent = '◄';
    leftBtn.onclick = () => cycleFeature(f.key, -1);

    const label = document.createElement('span');
    label.className = 'control-label';
    label.textContent = f.label;

    const rightBtn = document.createElement('button');
    rightBtn.className = 'arrow-btn';
    rightBtn.textContent = '►';
    rightBtn.onclick = () => cycleFeature(f.key, 1);

    row.append(leftBtn, label, rightBtn);
    controlsEl.appendChild(row);
  });
  
  updatePreview();
}