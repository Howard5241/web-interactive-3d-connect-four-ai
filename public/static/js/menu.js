const REFRESH_MS = 15000;

const nameInput = document.getElementById('player-name');
const errorBox = document.getElementById('menu-error');

try {
    nameInput.value = localStorage.getItem('c4-name') || '';
} catch (e) { /* storage blocked */ }

nameInput.addEventListener('input', () => {
    try {
        localStorage.setItem('c4-name', nameInput.value.trim());
    } catch (e) { /* storage blocked */ }
});

const goToRoom = code => { location.href = `/r/${code}`; };

document.getElementById('create-btn').addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    btn.disabled = true;
    errorBox.textContent = '';
    try {
        const res = await fetch('/api/rooms', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: document.getElementById('room-name').value,
                visibility: document.querySelector('input[name="visibility"]:checked').value,
            }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not create the room.');
        goToRoom(data.code);
    } catch (e) {
        errorBox.textContent = e.message;
        btn.disabled = false;
    }
});

// Accepts a bare code or a pasted room link.
document.getElementById('join-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.textContent = '';
    const raw = document.getElementById('join-code').value.trim();
    const code = (raw.match(/\/r\/([A-Za-z0-9]+)/)?.[1] || raw).toLowerCase();
    if (!/^[a-z0-9]{4,16}$/.test(code)) {
        errorBox.textContent = 'That does not look like a room code.';
        return;
    }
    const res = await fetch(`/api/rooms/${code}`).catch(() => null);
    if (!res || !res.ok) {
        errorBox.textContent = 'No room with that code.';
        return;
    }
    goToRoom(code);
});

function renderRooms(rooms) {
    const list = document.getElementById('room-list');
    list.innerHTML = '';
    if (!rooms.length) {
        const li = document.createElement('li');
        li.className = 'empty';
        li.textContent = 'No public rooms right now. Create one!';
        list.appendChild(li);
        return;
    }
    for (const room of rooms) {
        const li = document.createElement('li');
        const title = document.createElement('span');
        title.className = 'room-title';
        title.textContent = room.name;
        const meta = document.createElement('span');
        meta.className = 'room-meta';
        meta.textContent = `${room.players}/2 playing · ${room.viewers} here`;
        const join = document.createElement('button');
        join.textContent = 'Join';
        join.addEventListener('click', () => goToRoom(room.code));
        li.append(title, meta, join);
        list.appendChild(li);
    }
}

async function refreshRooms() {
    try {
        const res = await fetch('/api/rooms');
        if (res.ok) renderRooms((await res.json()).rooms);
    } catch (e) { /* keep the last list */ }
}

refreshRooms();
setInterval(() => {
    if (!document.hidden) refreshRooms();
}, REFRESH_MS);
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshRooms();
});
