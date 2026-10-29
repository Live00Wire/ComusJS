// ==========================================
// INDEX.JS - Master Controller
// 
// This file initializes ComusJS and wires up the UI and Game logic.
// It serves as a reference implementation for building games on ComusJS.
// ==========================================
import { ComusJS } from '../comus.js'; // Note the relative path to the engine!
import { ui, showScreen, renderLobby, appendChatMessage } from './ui.js';
import { setupAvatarCreator, getCurrentAvatar, getSavedName, hasSavedProfile } from './avatar.js';
import { createEmptyBoard, checkWin, renderGameBoard } from './game.js';

// --- 1. INITIALIZATION ---
// Create a new engine instance, enabling URL Deep Links (?room=ID)
const engine = new ComusJS({ enableDeepLinks: true });
let pendingRoomId = ComusJS.getRoomFromUrl();

ui.nameInput.value = getSavedName();
setupAvatarCreator(ui.preview, ui.controls);

// UX: Auto-Skip Profile Screen if the user previously saved one
if (hasSavedProfile()) {
  engine.profile.name = getSavedName();
  engine.profile.avatar = getCurrentAvatar();
  if (pendingRoomId) {
    ui.roomIdText.textContent = `Joining ${pendingRoomId}...`;
    showScreen('room');
    engine.joinRoom(pendingRoomId);
    pendingRoomId = null;
  } else {
    showScreen('menu');
  }
}

// --- 2. DOM EVENT LISTENERS (Sending commands to Engine) ---

ui.editProfileBtn.addEventListener('click', () => showScreen('profile'));

document.getElementById('btn-continue').addEventListener('click', () => {
  engine.profile.name = ui.nameInput.value.trim() || "Anon";
  engine.profile.avatar = getCurrentAvatar();
  
  // Save profile to local storage for next time
  localStorage.setItem('comus_profile', JSON.stringify({ 
    name: engine.profile.name, 
    avatar: engine.profile.avatar 
  }));
  
  if (pendingRoomId) {
    ui.roomIdText.textContent = `Joining ${pendingRoomId}...`;
    showScreen('room');
    engine.joinRoom(pendingRoomId);
    pendingRoomId = null; 
  } else showScreen('menu'); 
});

ui.copyLinkBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(window.location.href).then(() => {
    const original = ui.copyLinkBtn.textContent;
    ui.copyLinkBtn.textContent = "✅ Copied!";
    setTimeout(() => ui.copyLinkBtn.textContent = original, 2000);
  });
});

// Engine Triggers
document.getElementById('btn-create').addEventListener('click', () => engine.createRoom());
document.getElementById('btn-join').addEventListener('click', () => engine.joinRoom(ui.roomInput.value.trim()));
ui.leaveBtn.addEventListener('click', () => { engine.leaveRoom(); ui.board.innerHTML = ''; });
ui.leaveGameBtn.addEventListener('click', () => { engine.leaveRoom(); ui.board.innerHTML = ''; });
ui.rematchBtn.addEventListener('click', () => engine.sendAction({ type: 'VOTE_REMATCH' }));

// Global Chat
function handleSendChat() {
  const text = ui.chatInput.value.trim();
  if (text) { engine.sendChatMessage(text); ui.chatInput.value = ''; }
}
ui.chatSendBtn.addEventListener('click', handleSendChat);
ui.chatInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') handleSendChat(); });

// Start Game Handler (Only the Host sees this button)
ui.startBtn.addEventListener('click', () => {
  if (!engine.isHost) return;
  const playerIds = Array.from(engine.players.keys());
  const [p1, p2] = playerIds;
  
  // The Host defines the initial state of the game
  engine.turnQueue = [p1, p2]; 
  engine.setState('turnQueue', [p1, p2]); 
  engine.setState('p1', p1);
  engine.setState('p2', p2);
  engine.setState('board', createEmptyBoard());
  engine.setState('winner', null);
  engine.setState('winningCells', null);
  engine.setState('rematchVotes', []); 
  
  // Triggers the UI swap for all connected clients
  engine.triggerPhaseChange('PLAYING');
  engine.advanceTurn(1); // Give P1 the turn
});


// --- 3. ENGINE EVENT LISTENERS (Reacting to Network) ---

engine.on('roomCreated', (roomId) => { ui.roomIdText.textContent = `Room: ${roomId}`; showScreen('room'); ui.chatContainer.style.display = 'block'; });
engine.on('connectedToHost', () => { ui.roomIdText.textContent = `Room: ${engine.roomId}`; showScreen('room'); ui.chatContainer.style.display = 'block'; });
engine.on('chatMessage', (data) => appendChatMessage(data.text, data.senderId, engine));

// Handle Disconnections & Fail-safes
engine.on('disconnected', (reason) => { 
  showScreen('menu'); 
  ui.chatContainer.style.display = 'none'; 
  ui.chatMessages.innerHTML = ''; 
  
  // Surface rejection reasons (e.g. "Room is full", "Version mismatch")
  if (reason && reason !== 'Left room') {
    alert(`Disconnected: ${reason}`);
  }
});

// System Chat Notifications
engine.on('playerJoined', (player) => { 
  renderLobby(engine);
  if (player.id !== engine.myId) appendChatMessage(`${player.name} joined the room.`, 'SYSTEM', engine);
});

// Host Migration & Soft-Lock Mitigation
engine.on('playerDisconnected', (droppedId) => {
  const droppedPlayer = engine.players.get(droppedId);
  const droppedName = droppedPlayer ? droppedPlayer.name : "A player";
  
  renderLobby(engine);
  appendChatMessage(`${droppedName} left the room.`, 'SYSTEM', engine);
  
  // If we are mid-game, and an active player disconnects, the Host aborts the match
  if (engine.isHost && engine.phase === 'PLAYING' && (engine.getState('turnQueue') || []).includes(droppedId)) {
    engine.sendChatMessage("An active player disconnected. Game aborted.");
    engine.setState('board', createEmptyBoard());
    engine.setState('winner', null);
    engine.setState('winningCells', null);
    engine.setState('turnQueue', []);
    engine.triggerPhaseChange('LOBBY');
  }
});

// State Sync Catch-All (Triggers when joining late, or migrating hosts)
engine.on('stateSynced', () => {
  if (engine.phase === 'LOBBY') renderLobby(engine);
  if (engine.phase === 'PLAYING') { showScreen('game'); renderGameBoard(engine, ui); }
});

engine.on('phaseChanged', (newPhase) => {
  if (newPhase === 'PLAYING') { showScreen('game'); renderGameBoard(engine, ui); }
});

engine.on('stateChanged', () => { if (engine.phase === 'PLAYING') renderGameBoard(engine, ui); });
engine.on('turnChanged', () => { if (engine.phase === 'PLAYING') renderGameBoard(engine, ui); });


// --- 4. GAME RULES & ACTION VALIDATION (Host Authority) ---

// Before the Host processes an action, it passes through this validator.
// This prevents cheating! (e.g., A hacked client sending a DROP out of turn)
engine.useActionValidator((action, senderId, state) => {
  if (action.type === 'DROP') {
    if (senderId !== engine.turnQueue[engine.currentTurnIndex]) return false; // Not their turn
    if (state.winner) return false; // Game is over
    return state.board[0][action.column] === null; // Column is not full
  }
  if (action.type === 'VOTE_REMATCH') return state.winner !== null; 
  return true;
});

// The Host processes validated actions and broadcasts the result via setState()
engine.on('actionReceived', ({ action, senderId }) => {
  if (action.type === 'DROP') {
    let newBoard = JSON.parse(JSON.stringify(engine.getState('board')));
    
    // Gravity simulation: find lowest empty row
    for (let r = 5; r >= 0; r--) {
      if (newBoard[r][action.column] === null) {
        newBoard[r][action.column] = senderId;
        break;
      }
    }
    
    engine.setState('board', newBoard);

    // Check for win condition
    const winCells = checkWin(newBoard, senderId);
    if (winCells) {
      engine.setState('winningCells', winCells);
      engine.setState('winner', senderId);
    } else if (newBoard[0].every(col => col !== null)) {
      engine.setState('winner', 'DRAW');
    } else {
      engine.advanceTurn(1);
    }
  }
  
  if (action.type === 'VOTE_REMATCH') {
    let votes = engine.getState('rematchVotes') || [];
    if (!votes.includes(senderId)) votes.push(senderId);
    engine.setState('rematchVotes', votes);
    
    // If both players voted, reset the board and swap turn order
    if (votes.length >= 2) {
      const newQueue = [(engine.getState('turnQueue'))[1], (engine.getState('turnQueue'))[0]];
      engine.turnQueue = newQueue;
      engine.setState('turnQueue', newQueue);
      engine.setState('board', createEmptyBoard());
      engine.setState('winner', null);
      engine.setState('winningCells', null);
      engine.setState('rematchVotes', []);
      engine.currentTurnIndex = -1;
      engine.advanceTurn(1);
    }
  }
});