# Weekend Music Quiz

A polished, host-controlled Jeopardy-style music quiz that uses YouTube clips. It is plain HTML, CSS, and JavaScript: there is no build step and no backend.

## Run the quiz

Serve this folder through a small local web server (opening `index.html` directly may prevent YouTube embeds in some browsers):

```sh
python -m http.server 8000
```

Then open `http://localhost:8000`. An internet connection is required for the YouTube IFrame Player API and videos. Click a point value, use the video controls, reveal the answer, and award or deduct points. Team names, scores, completed questions, team count, and editor changes are saved in the browser.

## Deploy to GitHub Pages

1. Push these files to a GitHub repository.
2. Open the repository's **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**.
4. Select the branch (usually `main`) and the root folder, then save.

All paths are relative, so the app works at an address such as `https://USERNAME.github.io/music-quiz/`.

## Create and edit questions

Click the gear button to open Game Settings and the Quiz Editor. Game Settings lets you choose between one and eight teams or reset the game. Select a question on the left and edit its category, points, YouTube URL, timestamps, prompt, answer, song, artist, or answer playback duration. Categories and the board are generated from the saved questions. Press **Save quiz** to apply the changes. Saving a quiz clears completed-question marks but preserves team names and scores.

For source-controlled quiz data, edit `quiz-data.js`. Browser editor changes are stored in `localStorage` and take precedence over that file until browser storage is cleared.

Example question:

```js
{
  category: "First Words",
  points: 100,
  youtube: "https://www.youtube.com/watch?v=VIDEO_ID",
  start: 0,
  stop: "0:18.3",
  revealStart: "0:18.3",
  question: "What are the first words?",
  answer: "Hello, it's me",
  song: "Hello",
  artist: "Adele",
  answerPlaybackDuration: 8
}
```

## YouTube URLs and timestamps

Paste normal `youtube.com/watch`, `youtu.be`, `youtube.com/shorts`, or `youtube.com/embed` URLs. The video ID is extracted automatically. A video must allow embedding; private, removed, age-restricted, region-blocked, or embedding-disabled videos may not play.

Clip start, clip stop, and reveal start can be seconds (`83.5`) or readable `MM:SS` timestamps (`"1:23.5"`). For a twelve-second clip, use start `0:00` and stop `0:12` (not `12:00`, which means twelve minutes). The app checks the player's current playback time about every 75 ms and pauses at the cutoff, avoiding timer drift caused by buffering. Revealing the answer starts playback at `revealStart` for `answerPlaybackDuration` seconds.

The editor's timestamp helper can load the question's video. Play or scrub using the YouTube controls, then capture the clip start, clip stop, or reveal start. It displays both seconds and `MM:SS.s`.

## Import and export

In the editor, **Export quiz** downloads the current draft as JSON. **Import quiz** validates a previously exported JSON file and loads it into the editor; review it and press **Save quiz** to apply it. Imports require a title, one or more questions, valid categories and points, valid timestamps with stop after start, and valid YouTube URLs when supplied.

## First Words and Finish the Lyrics

For **First Words**, make the normal clip end immediately before the opening vocal. For **Finish the Lyrics**, end immediately before the lyric contestants must continue. Set `revealStart` where the answer begins. Revealing the answer immediately plays from that point for `answerPlaybackDuration` seconds (8 by default); **Play answer** repeats it.

## Keyboard shortcuts

- `Space`: play or pause the question clip
- `R`: restart the clip from its configured start
- `A`: reveal the answer
- `Esc`: return to the board without marking the question complete

Shortcuts are ignored while typing in the editor or a team-name field. Returning to the board keeps a question available. After revealing, choose 0–5 points independently for every team, then apply the points and close the question.

## Reset and troubleshooting

Open the gear menu and choose **Reset game**. After confirmation, it restores two default teams and clears team names, scores, and completed questions. It does not delete the custom quiz saved by the editor. Browser storage contains no YouTube authentication data.

If a clip does not play, check the displayed host message, confirm that the URL and timestamps are valid, and verify that the video is public and permits embedding. Browsers also require playback to begin from a user interaction, so the host must press a play control.
