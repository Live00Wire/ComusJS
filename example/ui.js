// ==========================================
// UI.JS - DOM Mapping & Generic Menu Views
// 
// This file acts as the bridge between the HTML and the JS.
// It maps the DOM elements and provides generic rendering 
// functions (like the Lobby grid and Global Chat).
// ==========================================
import { renderAvatarSVG } from './avatar.js';

// Centralized DOM mapping
export const ui = {
  screens: {
    profile: document.getElementById('screen-profile'),
    menu: document.getElementById('screen-menu'),
    room: document.getElementById('screen-room'),
    game: document.getElementById('screen-game')
  },
  preview: document.getElementById('preview'),
  controls: document.getElementById('controls-container'),
  nameInput: document.getElementById('input-name'),
  roomInput: document.getElementById('input-room'),
  roomIdText: document.getElementById('text-room-id'),
  lobbyGrid: document.getElementById('lobby-grid'),
  startBtn: document.getElementById('btn-start'),
  leaveBtn: document.getElementById('btn-leave'),
  leaveGameBtn: document.getElementById('btn-leave-game'),
  copyLinkBtn: document.getElementById('btn-copy-link'),
  editProfileBtn: document.getElementById('btn-edit-profile'),
  gameStatus: document.getElementById('text-game-status'),
  rematchBtn: document.getElementById('btn-vote-rematch'),
  board: document.getElementById('c4-board'),
  chatContainer: document.getElementById('chat-container'),
  chatMessages: document.getElementById('chat-messages'),
  chatInput: document.getElementById('input-chat'),
  chatSendBtn: document.getElementById('btn-send-chat')
};

/**
 * Hides all screens and shows the requested one.
 */
export function showScreen(screenName) {
  Object.values(ui.screens).forEach(screen => screen.style.display = 'none');
  ui.screens[screenName].style.display = 'block';
}

/**
 * Renders the player avatars in the lobby grid based on the ComusJS engine map.
 */
export function renderLobby(engine) {
  ui.lobbyGrid.innerHTML = '';
  
  // UX: Change button text if they are the last person in the room
  const isLastPerson = engine.players.size <= 1;
  ui.leaveBtn.textContent = isLastPerson ? "Close Room" : "Leave Room";

  // Render each player card
  engine.players.forEach((player) => {
    const card = document.createElement('div');
    card.style.cssText = 'display: flex; flex-direction: column; align-items: center; padding: 12px; background: #f8f9fa; border-radius: 12px; width: 100px; text-align: center; gap: 8px; border: 1px solid #dee2e6;';
    card.innerHTML = `
      <div style="width: 60px; height: 60px; background: #fff; border-radius: 50%; border: 2px solid #ced4da; overflow: hidden; display: flex; align-items: center; justify-content: center;">
        ${renderAvatarSVG(player.avatar)}
      </div>
      <div style="font-size: 14px; font-weight: 600; word-break: break-all;">${player.name}</div>
      <div style="font-size: 10px; color: #6c757d; font-family: monospace;">${player.isHost ? '👑 HOST' : 'PLAYER'}</div>
    `;
    ui.lobbyGrid.appendChild(card);
  });

  // Only the Host is allowed to start the game
  if (engine.isHost) {
    ui.startBtn.style.display = 'inline-block';
    ui.startBtn.disabled = engine.players.size < 2; 
    ui.startBtn.textContent = engine.players.size < 2 ? "Waiting for players..." : "Start Game";
  } else {
    ui.startBtn.style.display = 'none';
  }
}

/**
 * Appends a message to the global chat box. Supports "SYSTEM" notifications.
 */
export function appendChatMessage(text, senderId, engine) {
  const msgDiv = document.createElement('div');
  
  if (senderId === 'SYSTEM') {
    msgDiv.style.cssText = 'text-align: center; color: #6c757d; font-size: 12px; margin: 4px 0; font-style: italic; align-self: center;';
    msgDiv.textContent = text;
  } else {
    const isSelf = senderId === engine.myId;
    const player = engine.players.get(senderId);
    const name = player ? player.name : "Unknown";

    msgDiv.className = `chat-bubble ${isSelf ? 'chat-self' : 'chat-other'}`;
    msgDiv.innerHTML = `<span class="chat-name">${name}</span>${text}`;
  }
  
  ui.chatMessages.appendChild(msgDiv);
  ui.chatMessages.scrollTop = ui.chatMessages.scrollHeight; // Auto-scroll to bottom
}