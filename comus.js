/**
 * @class EventEmitter
 * A lightweight event emitter for internal engine pub/sub.
 */
class EventEmitter {
  constructor() { this.events = {}; }
  on(event, listener) {
    if (!this.events[event]) this.events[event] = [];
    this.events[event].push(listener);
  }
  emit(event, ...args) {
    if (this.events[event]) this.events[event].forEach(listener => listener(...args));
  }
}

/**
 * @class ComusJS
 * A host-authoritative, peer-to-peer multiplayer game engine over WebRTC.
 * Features deterministic host migration, event sourcing (ledger), and state rollbacks.
 */
export class ComusJS extends EventEmitter {
  /**
   * Initializes the engine with configuration parameters.
   * @param {Object} config Engine configuration options.
   * @param {number} [config.maxPlayers=99] Maximum allowed players in a room.
   * @param {number} [config.maxLedgerSize=5000] Max events to store before truncating history.
   * @param {string} [config.name="Anon"] The local player's display name.
   * @param {Object|string} [config.avatar="👽"] The local player's avatar or avatar config.
   * @param {boolean} [config.enableDeepLinks=false] If true, syncs the room ID to the URL bar.
   * @param {string} [config.engineVersion="1.0.0"] Prevents outdated clients from joining.
   */
  constructor(config = {}) {
    super();
    
    this.engineVersion = config.engineVersion || "1.0.0";
    this.maxPlayers = config.maxPlayers || 99;
    this.maxLedgerSize = config.maxLedgerSize || 5000;
    this.roomId = "";
    this.myId = "";
    this.profile = { name: config.name || "Anon", avatar: config.avatar || "👽" };
    
    this.peer = null;
    this.isHost = false;
    this.hostConnection = null;
    this.connections = new Map();
    this.hostLastSeen = Date.now();
    this.migrationInProgress = false;
    this.heartbeatInterval = setInterval(() => this._tickHeartbeats(), 5000);
    this.clockOffset = 0; 
    
    this.phase = "LOBBY";
    this.round = 0;
    this.maxRounds = config.maxRounds || 1;
    this.turnQueue = [];
    this.currentTurnIndex = -1;
    this.turnDirection = 1;
    this.pendingActions = new Set();
    this.submittedActions = {};
    this.players = new Map();
    this.state = {};
    
    this.localSequence = 0;        
    this.pendingInputs = [];       
    this.lastProcessedInputs = {}; 
    this.ticker = null;
    this.ledger = [];
    this.rateLimits = new Map(); // Anti-Spam Tracker

    this.middlewares = [];
    this.actionValidators = [];
    this.chatInterceptor = null;
    this.codec = {    
      encode: (data) => data,
      decode: (data) => data
    };

    this.enableDeepLinks = config.enableDeepLinks || false;
    if (this.enableDeepLinks && typeof window !== 'undefined' && window.history) {
      this._bindUrlSyncing();
    }

    // Deterministic RNG synced across all clients for predictable simulations
    this.Math = {
      _seed: 0,
      seedRNG: (seed) => { this._seed = seed; },
      random: () => {
        let t = this._seed += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
      }
    };
  }

  /**
   * Extracts the room ID from the browser's URL search parameters.
   * @returns {string|null} The room ID if present, otherwise null.
   */
  static getRoomFromUrl() {
    if (typeof window === 'undefined') return null;
    const params = new URLSearchParams(window.location.search);
    return params.get('room') ? params.get('room').toUpperCase().trim() : null;
  }

  /**
   * Creates a new peer-to-peer room and establishes this client as the Host.
   * @param {string} [existingId=null] Optional specific ID to bind to (used during migration).
   */
  createRoom(existingId = null) {
    this.isHost = true;
    this.roomId = existingId ? existingId.replace('comus-', '') : Math.random().toString(36).substring(2, 7).toUpperCase();
    this.peer = existingId ? new Peer(existingId) : new Peer('comus-' + this.roomId);

    this.peer.on('open', (id) => {
      this.myId = id;
      localStorage.setItem('comus_session', JSON.stringify({ role: 'HOST', room: this.roomId, id: id }));
      if (!existingId) this._addPlayer(id, this.profile.name, this.profile.avatar, true);
      this.emit('roomCreated', this.roomId);
    });

    this.peer.on('connection', (conn) => {
      this.connections.set(conn.peer, conn);
      conn.on('open', () => {
        conn.send(this.codec.encode({ type: 'SYNC_STATE', state: this._getSyncState(), acks: this.lastProcessedInputs }));
        conn.send(this.codec.encode({ type: 'CLOCK_SYNC', hostTime: Date.now() }));
      });
      conn.on('data', (raw) => {
        const data = this.codec.decode(raw);
        this._runMiddlewares(data, conn.peer, (processedData) => this._routeData(processedData, conn.peer));
      });
      conn.on('close', () => this._handlePlayerDisconnect(conn.peer));
    });
  }

  /**
   * Connects to an existing room as a Client.
   * @param {string} roomId The ID of the room to join.
   * @param {string} [existingPeerId=null] Optional specific ID to reuse.
   */
  joinRoom(roomId, existingPeerId = null) {
    this.roomId = roomId.toUpperCase();
    this.isHost = false;
    this.migrationInProgress = false;
    this.localSequence = 0;
    this.pendingInputs = [];
    
    if (this.peer) this.peer.destroy();
    this.peer = existingPeerId ? new Peer(existingPeerId) : new Peer();

    this.peer.on('open', (id) => {
      this.myId = id;
      this.hostConnection = this.peer.connect('comus-' + this.roomId);
      localStorage.setItem('comus_session', JSON.stringify({ role: 'CLIENT', room: this.roomId, id: id }));

      // FAIL-SAFE 1: 5-Second Connection Timeout
      const connectionTimeout = setTimeout(() => {
        if (!this.hostConnection || !this.hostConnection.open) {
          this.emit('disconnected', 'Room not found or Host is unreachable.');
          this.leaveRoom();
        }
      }, 5000);

      this.hostConnection.on('open', () => {
        clearTimeout(connectionTimeout); // Cancel timeout if connected
        this.hostLastSeen = Date.now();
        this.emit('connectedToHost');
        this.networkSend({ 
          type: 'REQ_JOIN', 
          name: this.profile.name, 
          avatar: this.profile.avatar, 
          engineVersion: this.engineVersion 
        });
      });
      
      this.hostConnection.on('data', (raw) => {
        const data = this.codec.decode(raw);
        this._runMiddlewares(data, 'HOST', (processedData) => this._routeData(processedData, 'HOST'));
      });
      this.hostConnection.on('close', () => this._handleHostDisconnect());
    });
  }

  /**
   * Disconnects from the current room and tears down the peer connection.
   */
  leaveRoom() {
    this.stopTicker();
    clearInterval(this.heartbeatInterval);
    if (this.peer) this.peer.destroy();
    localStorage.removeItem('comus_session');
    
    this.reset();
    
    this.emit('disconnected', 'Left room');
  }

  /**
   * Completely wipes the engine's internal state to prepare for a new room.
   */
  reset() {
    this.roomId = "";
    this.peer = null;
    this.isHost = false;
    this.hostConnection = null;
    this.connections = new Map();
    this.migrationInProgress = false;
    
    this.phase = "LOBBY";
    this.round = 0;
    this.turnQueue = [];
    this.currentTurnIndex = -1;
    this.pendingActions = new Set();
    this.submittedActions = {};
    
    this.players.clear();
    this.state = {};
    
    this.localSequence = 0;        
    this.pendingInputs = [];       
    this.lastProcessedInputs = {}; 
    this.ledger = [];
    this.rateLimits.clear();
  }

  /**
   * Sets custom binary encoding/decoding functions (e.g., MessagePack).
   * @param {Function} encodeFn Function to serialize outgoing payloads.
   * @param {Function} decodeFn Function to deserialize incoming payloads.
   */
  setCodec(encodeFn, decodeFn) {
    this.codec = { encode: encodeFn, decode: decodeFn };
  }

  /**
   * Registers a middleware function to intercept incoming network packets.
   * @param {Function} middlewareFn Function(packet, senderId, next)
   */
  use(middlewareFn) {
    this.middlewares.push(middlewareFn);
  }

  _runMiddlewares(packet, senderId, callback) {
    let index = 0;
    const next = () => {
      if (index < this.middlewares.length) {
        this.middlewares[index++](packet, senderId, next);
      } else {
        callback(packet);
      }
    };
    next();
  }

  /**
   * Broadcasts a payload to connected peers.
   * @param {Object} payload The data to send.
   * @param {string} [targetId=null] Specific player ID to send to (Host only).
   * @param {string} [excludeId=null] Player ID to exclude from broadcast (Host only).
   */
  networkSend(payload, targetId = null, excludeId = null) {
    const encodedPayload = this.codec.encode(payload);
    
    if (this.isHost) {
      if (targetId) {
        if (targetId === this.myId) this._runMiddlewares(payload, this.myId, (p) => this._handleClientRouting(p));
        else {
          const conn = this.connections.get(targetId);
          if (conn && conn.open) conn.send(encodedPayload);
        }
      } else {
        this.connections.forEach((conn, id) => {
          if (conn.open && id !== excludeId) conn.send(encodedPayload);
        });
      }
    } else {
      if (this.hostConnection && this.hostConnection.open) this.hostConnection.send(encodedPayload);
    }
  }

  _routeData(data, senderId) {
    if (this.players.has(senderId)) this.players.get(senderId).lastSeen = Date.now();
    if (!this.isHost && senderId === 'HOST') this.hostLastSeen = Date.now();
    if (this.isHost) this._handleHostRouting(data, senderId);
    else this._handleClientRouting(data);
  }

  _handleHostRouting(data, senderId) {
    switch (data.type) {
      case 'REQ_JOIN':
        // FAIL-SAFE 3: Version Syncing
        if (data.engineVersion !== this.engineVersion) {
          return this.networkSend({ type: 'JOIN_REJECTED', reason: 'Version mismatch. Please refresh your browser.' }, senderId);
        }

        const existingPlayer = this.players.get(senderId);
        if (existingPlayer) {
          existingPlayer.connected = true;
          this._syncState();
          this.networkSend({ type: 'SYNC_STATE', state: this._getSyncState(), acks: this.lastProcessedInputs }, senderId);
          this.networkSend({ type: 'CLOCK_SYNC', hostTime: Date.now() }, senderId);
          this.emit('playerReconnected', senderId);
          return;
        }
        if (this.players.size >= this.maxPlayers) {
          return this.networkSend({ type: 'JOIN_REJECTED', reason: 'Room is full.' }, senderId);
        }
        
        const isLateJoin = this.phase !== 'LOBBY';
        this._addPlayer(senderId, data.name, data.avatar, false, isLateJoin ? 'SPECTATOR' : 'PLAYER');
        if (isLateJoin) {
          this.networkSend({ type: 'SYNC_STATE', state: this._getSyncState(), acks: this.lastProcessedInputs }, senderId);
          this.networkSend({ type: 'CLOCK_SYNC', hostTime: Date.now() }, senderId);
        }
        break;
      case 'HEARTBEAT': break;
      case 'CHAT': this._processHostChat(data.text, senderId); break;
      case 'INPUT_STREAM':
        if (!this.lastProcessedInputs[senderId] || data.sequence > this.lastProcessedInputs[senderId]) {
          this.lastProcessedInputs[senderId] = data.sequence;
        }
        this._recordEvent('INPUT', data, senderId);
        this.emit('inputReceived', { input: data.input, sequence: data.sequence, senderId });
        break;
      case 'GAME_ACTION':
        // FAIL-SAFE 2: Rate limit to max 10 actions per second (100ms delay)
        const now = Date.now();
        const lastActionTime = this.rateLimits.get(senderId) || 0;
        
        if (now - lastActionTime < 100) {
          console.warn(`Spam detected from ${senderId}, dropping action.`);
          return; 
        }
        this.rateLimits.set(senderId, now);

        if (data.action?.type === 'YIELD_TURN' && senderId === this.turnQueue[this.currentTurnIndex]) {
          this.advanceTurn(1);
        } else {
          this._processIncomingAction(data.action, senderId);
        }
        break;
      case 'ASYNC_EVENT': 
        this._recordEvent('ASYNC_EVENT', data.action, senderId);
        this.emit('asyncEvent', { action: data.action, senderId }); 
        break;
      case 'SUBMIT_ACTION': this._handleActionSubmission(senderId, data.action); break;
    }
  }

  _handleClientRouting(data) {
    if (data.acks && data.acks[this.myId]) {
      const ackSeq = data.acks[this.myId];
      this.pendingInputs = this.pendingInputs.filter(p => p.sequence > ackSeq);
      this.emit('inputsAcknowledged', ackSeq);
    }

    switch (data.type) {
      case 'SYNC_STATE': this._applySyncState(data.state); break;
      case 'STATE_SYNC': 
        this.state[data.key] = data.value;
        this.emit('stateChanged', { key: data.key, value: data.value });
        break;
      case 'STATE_PATCH':
        this._deepMerge(this.state, data.updates);
        this.emit('statePatched', data.updates);
        break;
      case 'CLOCK_SYNC': this.clockOffset = data.hostTime - Date.now(); break;
      case 'PHASE_CHANGE':
        if (data.seed !== undefined) this.Math.seedRNG(data.seed);
        this.phase = data.phase;
        this.emit('phaseChanged', this.phase);
        break;
      case 'TURN_CHANGE':
        this.currentTurnIndex = data.turnIndex;
        this.emit('turnChanged', data.activePlayerId);
        break;
      case 'CHAT': this.emit('chatMessage', { text: data.text, senderId: data.senderId }); break;
      case 'HEARTBEAT': break;
      case 'GAME_ACTION': this.emit('actionReceived', { action: data.action, senderId: data.senderId }); break;
      case 'ACTION_REJECTED': this.emit('actionRejected', data.reason); break;
      case 'ASYNC_EVENT': this.emit('asyncEvent', { action: data.action, senderId: data.senderId }); break;
      case 'JOIN_REJECTED': 
        this.emit('disconnected', data.reason || 'Connection rejected.'); 
        break;
    }
  }

  _tickHeartbeats() {
    const now = Date.now();
    if (this.isHost) {
      this.players.forEach((p, id) => {
        if (!p.isHost && p.connected && (now - p.lastSeen > 15000)) this._handlePlayerDisconnect(id);
      });
      if (Math.random() < 0.2) this._syncClock();
    } else if (this.hostConnection && this.hostConnection.open) {
      this.networkSend({ type: 'HEARTBEAT' });
      if (!this.migrationInProgress && (now - this.hostLastSeen > 15000)) {
        this.hostConnection.close();
        this._handleHostDisconnect();
      }
    }
  }

  _handleHostDisconnect() {
    if (this.isHost || this.migrationInProgress) return;
    this.migrationInProgress = true;
    this.emit('migrationStarted', 'Host disconnected. Negotiating new host...');

    const oldHostId = 'comus-' + this.roomId;
    this.players.delete(oldHostId);

    // Host Election Logic: Determine the new host deterministically so all clients agree.
    let candidateIds = this.turnQueue.filter(id => this.players.has(id) && this.players.get(id).connected && id !== oldHostId);
    if (candidateIds.length === 0) {
      candidateIds = Array.from(this.players.values())
        .filter(p => p.id !== oldHostId && p.connected)
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(p => p.id);
    }

    if (candidateIds.length === 0) {
      this.emit('disconnected', 'Session collapsed.');
      this.migrationInProgress = false;
      return;
    }

    if (candidateIds[0] === this.myId) this._promoteToHost();
    else setTimeout(() => this.joinRoom(this.roomId, this.myId), 3000);
  }

  _promoteToHost() {
    this.isHost = true;
    const oldMyId = this.myId;
    if (this.peer) this.peer.destroy();
    this.hostConnection = null;
    this.clockOffset = 0; 
    this.lastProcessedInputs = {}; 

    setTimeout(() => {
      this.peer = new Peer('comus-' + this.roomId);
      this.peer.on('open', (id) => {
        this.myId = id;
        this.migrationInProgress = false;
        localStorage.setItem('comus_session', JSON.stringify({ role: 'HOST', room: this.roomId, id: id }));
        
        if (this.players.has(oldMyId)) {
          const myData = this.players.get(oldMyId);
          myData.id = id;
          myData.isHost = true;
          this.players.delete(oldMyId);
          this.players.set(id, myData);
        }

        const qIdx = this.turnQueue.indexOf(oldMyId);
        if (qIdx !== -1) this.turnQueue[qIdx] = id;

        this.emit('hostMigrated', this.roomId);
        this._syncState(); 
      });

      this.peer.on('connection', (conn) => {
        this.connections.set(conn.peer, conn);
        conn.on('open', () => {
          conn.send(this.codec.encode({ type: 'SYNC_STATE', state: this._getSyncState(), acks: this.lastProcessedInputs }));
          conn.send(this.codec.encode({ type: 'CLOCK_SYNC', hostTime: Date.now() }));
        });
        conn.on('data', (raw) => {
          const data = this.codec.decode(raw);
          this._runMiddlewares(data, conn.peer, (processedData) => this._routeData(processedData, conn.peer));
        });
        conn.on('close', () => this._handlePlayerDisconnect(conn.peer));
      });
    }, 1500);
  }

  _addPlayer(id, name, avatar, isHost, role = 'PLAYER') {
    const p = { id, name, avatar, isHost, score: 0, role, connected: true, lastSeen: Date.now() };
    this.players.set(id, p);
    this.emit('playerJoined', p);
    if (this.isHost) this._syncState();
  }

  _handlePlayerDisconnect(id) {
    this.connections.delete(id);
    const p = this.players.get(id);
    if (p) {
      p.connected = false;
      this.emit('playerDisconnected', id);
      this._syncState();
    }
  }

  /**
   * Exports the entire game state and ledger for saving or replays.
   * @returns {Object} A snapshot of the current room state.
   */
  exportState() {
    return {
      phase: this.phase,
      round: this.round,
      turnQueue: this.turnQueue,
      currentTurnIndex: this.currentTurnIndex,
      turnDirection: this.turnDirection,
      gameState: this.state,
      players: Array.from(this.players.values()),
      ledger: this.ledger,
      rngSeed: this.Math._seed
    };
  }

  /**
   * Restores the game state from an exported snapshot.
   * @param {Object} snapshot State generated by exportState().
   */
  hydrateState(snapshot) {
    this.phase = snapshot.phase;
    this.round = snapshot.round;
    this.turnQueue = snapshot.turnQueue;
    this.currentTurnIndex = snapshot.currentTurnIndex;
    this.turnDirection = snapshot.turnDirection;
    this.state = snapshot.gameState;
    this.ledger = snapshot.ledger || [];
    this.Math._seed = snapshot.rngSeed;
    
    this.players.clear();
    snapshot.players.forEach(p => this.players.set(p.id, p));

    if (this.isHost) {
      this._syncState();
      this.emit('stateHydrated', snapshot);
    }
  }

  /**
   * Sets a specific key in the shared game state (Host only).
   * @param {string} key The state key to update.
   * @param {*} value The new value.
   */
  setState(key, value) {
    if (!this.isHost) return;
    this.state[key] = value;
    this._recordEvent('STATE_SET', { key, value }, this.myId);
    this.networkSend({ type: 'STATE_SYNC', key, value, acks: this.lastProcessedInputs });
    this.emit('stateChanged', { key, value });
  }

  /**
   * Deep-merges an object into the shared game state (Host only).
   * @param {Object} updates The partial state to merge.
   */
  patchState(updates) {
    if (!this.isHost) return;
    this._deepMerge(this.state, updates);
    this._recordEvent('STATE_PATCH', updates, this.myId);
    this.networkSend({ type: 'STATE_PATCH', updates, acks: this.lastProcessedInputs });
    this.emit('statePatched', updates);
  }

  /**
   * Retrieves a value from the shared game state.
   * @param {string} key The state key to retrieve.
   * @returns {*}
   */
  getState(key) {
    return this.state[key];
  }

  _deepMerge(target, source) {
    for (const key in source) {
      if (source[key] instanceof Object && key in target) {
        Object.assign(source[key], this._deepMerge(target[key], source[key]));
      }
    }
    Object.assign(target || {}, source);
    return target;
  }

  _getSyncState() {
    return {
      phase: this.phase, turnQueue: this.turnQueue, currentTurnIndex: this.currentTurnIndex,
      gameState: this.state, players: Array.from(this.players.values()),
      rngSeed: this.Math._seed
    };
  }

  _applySyncState(stateData) {
    this.phase = stateData.phase;
    this.turnQueue = stateData.turnQueue || [];
    this.currentTurnIndex = stateData.currentTurnIndex || 0;
    this.state = stateData.gameState || {};
    if (stateData.rngSeed !== undefined) this.Math.seedRNG(stateData.rngSeed);
    this.players.clear();
    stateData.players.forEach(p => this.players.set(p.id, p));
    this.emit('stateSynced');
  }

  _syncState() {
    if (this.isHost) this.networkSend({ type: 'SYNC_STATE', state: this._getSyncState(), acks: this.lastProcessedInputs });
  }

  /**
   * Registers a validation function to approve or reject incoming gameplay actions.
   * @param {Function} fn Function(action, senderId, state) returning true/false.
   */
  useActionValidator(fn) {
    this.actionValidators.push(fn);
  }

  /**
   * Submits a gameplay action to the Host for validation and processing.
   * @param {Object} actionObj The action payload (must contain a type property).
   */
  sendAction(actionObj) {
    if (this.isHost) this._processIncomingAction(actionObj, this.myId);
    else this.networkSend({ type: 'GAME_ACTION', action: actionObj });
  }

  /**
   * Fires an asynchronous event (bypasses turn-queue logic) across the network.
   * @param {Object} actionObj The event payload.
   */
  sendAsyncEvent(actionObj) {
    if (this.isHost) {
      this.networkSend({ type: 'ASYNC_EVENT', action: actionObj, senderId: this.myId });
      this._recordEvent('ASYNC_EVENT', actionObj, this.myId);
      this.emit('asyncEvent', { action: actionObj, senderId: this.myId });
    } else {
      this.networkSend({ type: 'ASYNC_EVENT', action: actionObj });
    }
  }

  /**
   * Changes the global game phase (Host only).
   * @param {string} newPhase The new phase string (e.g., "PLAYING", "RESULTS").
   */
  triggerPhaseChange(newPhase) {
    if (!this.isHost) return;
    this.phase = newPhase;
    this._recordEvent('PHASE_CHANGE', newPhase, this.myId);
    this.networkSend({ type: 'PHASE_CHANGE', phase: newPhase });
    this.emit('phaseChanged', newPhase);
  }

  /**
   * Advances the turn queue by a specified number of steps (Host only).
   * @param {number} [steps=1] Number of steps to advance (can be negative for reverse).
   */
  advanceTurn(steps = 1) {
    if (!this.isHost || this.turnQueue.length === 0) return;
    this.currentTurnIndex = (this.currentTurnIndex + steps) % this.turnQueue.length;
    const activeId = this.turnQueue[this.currentTurnIndex];
    this._recordEvent('TURN_CHANGE', activeId, this.myId);
    this.networkSend({ type: 'TURN_CHANGE', turnIndex: this.currentTurnIndex, activePlayerId: activeId });
    this.emit('turnChanged', activeId);
  }

  /**
   * Locks the game into a simultaneous phase where specified players must submit hidden actions.
   * @param {Array<string>} participantsArray Array of player IDs required to submit.
   */
  startSimultaneousPhase(participantsArray) {
    if (!this.isHost) return;
    this.phase = 'SIMULTANEOUS';
    this.pendingActions = new Set(participantsArray);
    this.submittedActions = {};
    this.triggerPhaseChange('SIMULTANEOUS');
  }

  /**
   * Submits a hidden action during a simultaneous phase.
   * @param {Object} actionData The action to submit.
   */
  submitSimultaneousAction(actionData) {
    if (this.isHost) this._handleActionSubmission(this.myId, actionData);
    else this.networkSend({ type: 'SUBMIT_ACTION', action: actionData });
  }

  _processIncomingAction(action, senderId) {
    for (const validator of this.actionValidators) {
      if (!validator(action, senderId, this.state)) {
        this.networkSend({ type: 'ACTION_REJECTED', reason: 'Invalid move' }, senderId);
        return; 
      }
    }
    this._recordEvent('GAME_ACTION', action, senderId);
    this.emit('actionReceived', { action, senderId });
  }

  _handleActionSubmission(senderId, actionData) {
    if (!this.isHost || this.phase !== 'SIMULTANEOUS' || !this.pendingActions.has(senderId)) return;
    this.pendingActions.delete(senderId);
    this.submittedActions[senderId] = actionData;
    this.emit('playerLocked', senderId);

    if (this.pendingActions.size === 0) {
      this.triggerPhaseChange('PLAYING');
      this.emit('simultaneousResolved', this.submittedActions);
    }
  }

  /**
   * Gets the synchronized network time (adjusted by the clock offset from the host).
   * @returns {number} Timestamp in milliseconds.
   */
  getNetworkTime() {
    return Date.now() + this.clockOffset;
  }

  _syncClock() {
    if (this.isHost) this.networkSend({ type: 'CLOCK_SYNC', hostTime: Date.now() });
  }

  /**
   * Starts a real-time game loop ticker emitting at a set framerate (Host only).
   * @param {number} [fps=30] Frames per second for the tick event.
   */
  startTicker(fps = 30) {
    if (!this.isHost) return;
    this.stopTicker();
    this.ticker = setInterval(() => this.emit('tick'), 1000 / fps);
  }

  /**
   * Stops the real-time game loop ticker.
   */
  stopTicker() {
    if (!this.isHost) return;
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }

  /**
   * Streams a continuous input (e.g., movement vector) to the host for Client-Side Prediction.
   * @param {Object} inputData The input payload.
   * @returns {number} The sequence number of the sent input.
   */
  sendInput(inputData) {
    const sequence = ++this.localSequence;
    const packet = { sequence, input: inputData };

    if (this.isHost) {
      this.lastProcessedInputs[this.myId] = sequence;
      this._recordEvent('INPUT', packet, this.myId);
      this.emit('inputReceived', { input: inputData, sequence, senderId: this.myId });
    } else {
      this.pendingInputs.push(packet);
      if (this.pendingInputs.length > 500) this.pendingInputs.shift();
      this.networkSend({ type: 'INPUT_STREAM', ...packet });
    }
    return sequence;
  }

  /**
   * Retrieves locally predicted inputs that have not yet been acknowledged by the Host.
   * @returns {Array<Object>} List of unacknowledged input packets.
   */
  getPendingInputs() {
    return this.pendingInputs;
  }

  _recordEvent(type, payload, senderId) {
    if (!this.isHost) return;
    this.ledger.push({
      timestamp: this.getNetworkTime(),
      type,
      payload,
      senderId
    });
    if (this.ledger.length > this.maxLedgerSize) {
      this.ledger.shift();
    }
  }

  /**
   * Registers an interceptor function to filter or modify chat messages before broadcast.
   * @param {Function} fn Function(text, senderId) returning true to block the message.
   */
  setChatInterceptor(fn) {
    this.chatInterceptor = fn;
  }

  /**
   * Broadcasts a chat message to the room.
   * @param {string} text The message body.
   */
  sendChatMessage(text) {
    if (this.isHost) this._processHostChat(text, this.myId);
    else this.networkSend({ type: 'CHAT', text: text });
  }

  _processHostChat(text, senderId) {
    if (this.chatInterceptor && this.chatInterceptor(text, senderId)) return;
    this._recordEvent('CHAT', text, senderId);
    this.networkSend({ type: 'CHAT', text: text, senderId: senderId });
    this.emit('chatMessage', { text, senderId });
  }

  _bindUrlSyncing() {
    this.on('roomCreated', (roomId) => {
      const url = new URL(window.location);
      url.searchParams.set('room', roomId);
      window.history.replaceState({ path: url.href }, '', url.href);
    });
    
    this.on('connectedToHost', () => {
      const url = new URL(window.location);
      url.searchParams.set('room', this.roomId);
      window.history.replaceState({ path: url.href }, '', url.href);
    });
    
    this.on('disconnected', () => {
      const url = new URL(window.location);
      url.searchParams.delete('room');
      
      let cleanUrl = url.href;
      if (cleanUrl.endsWith('?')) cleanUrl = cleanUrl.slice(0, -1);
      
      window.history.replaceState({}, '', cleanUrl);
    });
  }
}