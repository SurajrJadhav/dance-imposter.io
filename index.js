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

const groups = {}; // groupId: { creatorId, creatorName, members: [{id, name}], songTypes, paused }

function generateGroupId() {
  return Math.floor(100000 + Math.random() * 900000).toString();
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
      members: [{ id: socket.id, name: username }],
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
    group.members.push({ id: socket.id, name: username });
    socket.join(groupId);
    socket.emit('groupJoined', {
      groupId,
      isCreator: false,
      creatorName: group.creatorName
    });
    io.to(groupId).emit('updateGroup', group.members);
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
      group.members = group.members.filter(m => m.id !== socket.id);
      delete group.songTypes[socket.id];
      if (group.members.length === 0) {
        delete groups[groupId];
      } else {
        io.to(groupId).emit('updateGroup', group.members);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
