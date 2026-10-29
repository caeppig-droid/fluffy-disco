# Escape the Island

A cooperative classroom game for the web. A shipwrecked crew moves around a looping island board, answers a question every time someone lands on a space, and collects supplies for a shared life raft. Fill all 10 raft slots before the questions run out to escape.

It runs entirely in the browser with no backend or database. Players connect directly to each other using [PeerJS](https://peerjs.com/).

## How to play

1. The teacher clicks **Host a game**, enters the teacher PIN, and shares the 4-letter room code or the **Copy join link**. Only someone with the PIN can host.
2. Everyone else enters their name and the room code, then clicks **Join game**.
3. The host clicks **Start the adventure**.
4. On your turn, roll the die and move around the island.
5. Every landing asks a question, and **every player** answers it. The next turn unlocks once everyone has answered.
6. Item spaces (wood, rope, mango, medkit) add to the shared raft.
7. **Win:** fill all 10 raft slots. **Lose:** the questions run out first.

The host's browser keeps the game state, so if the host closes their tab the game ends. A player who refreshes or loses connection rejoins automatically as the same person.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page structure |
| `style.css` | Island theme and layout |
| `script.js` | Game logic, PeerJS networking, and Teacher Mode |

Keep all three files at the top level of the repository, and keep `index.html` named exactly that.

## Teacher Mode

Teacher Mode lets you add, edit, and delete the trivia questions and their answers.

- **Open it:** press `Alt+Shift+T`, or triple-click the invisible bottom-left corner of the page. (`Ctrl+Shift+T` is also wired up, but many browsers reserve it for reopening closed tabs.)
- **Unlock it** with the PIN set in `script.js` (see below).
- **Where questions live:** they are saved in that device's browser (`localStorage`), and the game uses the questions on the device that hosts. Use **Export file** and **Import file** to move them between devices.
- **Answers:** matching ignores capitals and punctuation. Put alternate answers after a `|`, for example `6 | six`. Small typos are forgiven on longer words, and numbers must match exactly.
- **Bulk add:** paste one question per line, with the question and answer separated by a tab (two spreadsheet columns) or by `=>`.
- **How many:** 20 to 30 questions makes a fair game. The raft takes about 16 landings to fill on average.

### Changing the PIN

Open `script.js` and edit the `TEACHER_PIN` line near the top. The PIN lives only in this file, never in the HTML. Anyone who opens the page source can read it, so it keeps students out of the menu but is not real security. Change it before publishing to a public repository.

## Host it for free on GitHub Pages

1. Create a **public** repository.
2. Upload `index.html`, `style.css`, and `script.js` (not a zip file, and not inside a folder).
3. Go to **Settings > Pages**, set **Source** to **Deploy from a branch**, choose the **main** branch and the **/ (root)** folder, and click **Save**.
4. After a minute or two, your game is live at `https://YOUR-USERNAME.github.io/REPO-NAME/`.

Any static host works the same way (Netlify, Cloudflare Pages, Vercel). The game needs to be served over **https** for the copy buttons and reliable connections.

## Troubleshooting

- **Students can't join:** some school networks block WebRTC (the browser-to-browser technology PeerJS uses) or the PeerJS server. Test from a student device on the school network first, and ask your IT team if it fails.
- **"Multiplayer library did not load":** the network may block `cdn.jsdelivr.net`, where PeerJS is loaded from.
- **Fonts look different:** if Google Fonts is blocked, the game falls back to a system font and still works.
- **A player got stuck:** the host can press **Skip waiting** on a question, or roll for a student who stepped away.
- **Room code not found:** check the code with the host. It is 4 characters and has no `0`, `O`, `1`, or `I`.

## Credits

Built with plain HTML, CSS, and JavaScript, plus [PeerJS](https://peerjs.com/) (MIT licensed) for peer-to-peer connections. Fonts: Fredoka and Nunito from Google Fonts.
