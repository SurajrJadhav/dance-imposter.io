const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = 3000;

app.use(express.static('public'));

const groups = {}; // groupId: { creatorId, creatorName, creatorUsername, members: [{id, name, username}], sessions: {username: {socketId, isCreator, lastSeen}}, songTypes, paused }
const disconnectTimers = {}; // Track disconnect timers for cleanup

function generateGroupId() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function cleanupDisconnectedUser(groupId, username) {
  const group = groups[groupId];
  if (!group) return;

  const session = group.sessions[username];
  if (!session) return;

  // Check if user is still disconnected
  const timeSinceLastSeen = Date.now() - session.lastSeen;
  if (timeSinceLastSeen >= 30000) { // 30 seconds
    // Remove user from group
    delete group.sessions[username];
    group.members = group.members.filter(m => m.username !== username);
    delete group.songTypes[session.socketId];

    if (group.members.length === 0) {
      delete groups[groupId];
    } else {
      io.to(groupId).emit('updateGroup', group.members);
    }
  }
}

function getLocalSongs(folderName) {
  const fullPath = path.join(__dirname, 'public', folderName);
  return fs.readdirSync(fullPath).filter(file => file.endsWith('.mp3'));
}

io.on('connection', (socket) => {
  socket.on('createGroup', ({ username }) => {
    const groupId = generateGroupId();
    groups[groupId] = {
      creatorId: socket.id,
      creatorName: username,
      creatorUsername: username,
      members: [{ id: socket.id, name: username, username: username }],
      sessions: {
        [username]: {
          socketId: socket.id,
          isCreator: true,
          lastSeen: Date.now()
        }
      },
      songTypes: {},
      paused: false
    };
    socket.join(groupId);
    socket.emit('groupCreated', { groupId, isCreator: true, creatorName: username });
    io.to(groupId).emit('updateGroup', groups[groupId].members);
  });

  socket.on('joinGroup', ({ groupId, username }) => {
    if (!groups[groupId]) {
      socket.emit('errorMessage', 'Group not found.');
      return;
    }
    const group = groups[groupId];
    group.members.push({ id: socket.id, name: username, username: username });
    group.sessions[username] = {
      socketId: socket.id,
      isCreator: false,
      lastSeen: Date.now()
    };
    socket.join(groupId);
    socket.emit('groupJoined', {
      groupId,
      isCreator: false,
      creatorName: group.creatorName
    });
    io.to(groupId).emit('updateGroup', group.members);
  });

  socket.on('reconnect', ({ groupId, username }) => {
    if (!groups[groupId]) {
      socket.emit('reconnectFailed', 'Group no longer exists.');
      return;
    }

    const group = groups[groupId];
    const session = group.sessions[username];

    if (!session) {
      socket.emit('reconnectFailed', 'Session not found.');
      return;
    }

    // Clear any pending disconnect timer
    const timerKey = `${groupId}-${username}`;
    if (disconnectTimers[timerKey]) {
      clearTimeout(disconnectTimers[timerKey]);
      delete disconnectTimers[timerKey];
    }

    // Update socket ID in session
    const oldSocketId = session.socketId;
    session.socketId = socket.id;
    session.lastSeen = Date.now();

    // Update member's socket ID
    const member = group.members.find(m => m.username === username);
    if (member) {
      member.id = socket.id;
    }

    // Update creator ID if this is the creator
    if (session.isCreator) {
      group.creatorId = socket.id;
    }

    // Update song types mapping
    if (group.songTypes[oldSocketId]) {
      group.songTypes[socket.id] = group.songTypes[oldSocketId];
      delete group.songTypes[oldSocketId];
    }

    socket.join(groupId);
    socket.emit('reconnectSuccess', {
      groupId,
      isCreator: session.isCreator,
      creatorName: group.creatorName,
      paused: group.paused
    });

    // Send current song types to creator if they reconnected
    if (session.isCreator) {
      io.to(socket.id).emit('songTypes', group.songTypes);
    }

    io.to(groupId).emit('updateGroup', group.members);
  });

  socket.on('logout', ({ groupId, username }) => {
    if (!groups[groupId]) return;

    const group = groups[groupId];

    // Clear disconnect timer if exists
    const timerKey = `${groupId}-${username}`;
    if (disconnectTimers[timerKey]) {
      clearTimeout(disconnectTimers[timerKey]);
      delete disconnectTimers[timerKey];
    }

    // Remove session
    delete group.sessions[username];

    // Remove member
    group.members = group.members.filter(m => m.username !== username);
    delete group.songTypes[socket.id];

    if (group.members.length === 0) {
      delete groups[groupId];
    } else {
      io.to(groupId).emit('updateGroup', group.members);
    }

    socket.leave(groupId);
    socket.emit('logoutSuccess');
  });

  socket.on('playSong', ({ groupId }) => {
    const group = groups[groupId];
    if (!group || socket.id !== group.creatorId) return;

    const danceSongs = getLocalSongs('dance');
    const sadSongs = getLocalSongs('sad');
    const danceSong = danceSongs[Math.floor(Math.random() * danceSongs.length)];
    const sadSong = sadSongs[Math.floor(Math.random() * sadSongs.length)];

    group.songTypes = {};

    const members = group.members.filter(m => m.id !== group.creatorId);
    if (members.length < 3) {
      members.forEach(member => {
        group.songTypes[member.id] = 'dance';
        io.to(member.id).emit('startSong', { songUrl: `/dance/${danceSong}` });
      });
    } else {
      const imposterIndex = Math.floor(Math.random() * members.length);
      members.forEach((member, index) => {
        const type = index === imposterIndex ? 'sad' : 'dance';
        const file = type === 'sad' ? sadSong : danceSong;
        group.songTypes[member.id] = type;
        io.to(member.id).emit('startSong', { songUrl: `/${type}/${file}` });
      });
    }

    io.to(group.creatorId).emit('songTypes', group.songTypes);
    io.to(groupId).emit('updateGroup', group.members);
  });

  socket.on('togglePause', ({ groupId }) => {
    const group = groups[groupId];
    if (!group || socket.id !== group.creatorId) return;

    group.paused = !group.paused;
    const action = group.paused ? 'pauseSong' : 'resumeSong';

    group.members.forEach(m => {
      if (m.id !== group.creatorId) io.to(m.id).emit(action);
    });

    io.to(group.creatorId).emit('pausedStateChanged', group.paused);
  });

  socket.on('requestGroupMembers', ({ groupId }) => {
    if (groups[groupId]) {
      io.to(groupId).emit('updateGroup', groups[groupId].members);
    }
  });

  socket.on('disconnect', () => {
    for (const groupId in groups) {
      const group = groups[groupId];
      const member = group.members.find(m => m.id === socket.id);

      if (member && member.username) {
        const session = group.sessions[member.username];
        if (session) {
          // Update last seen time
          session.lastSeen = Date.now();

          // Set a timer to clean up if user doesn't reconnect
          const timerKey = `${groupId}-${member.username}`;
          disconnectTimers[timerKey] = setTimeout(() => {
            cleanupDisconnectedUser(groupId, member.username);
            delete disconnectTimers[timerKey];
          }, 30000); // 30 seconds to reconnect
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
