import SamJs from "sam-js";

let sam = new SamJs();

function sayWords(words: string) {
  sam.speak(words);
}

function playSound(id: string) {
  var audio = document.getElementById(id) as any;
  audio.play();
}

function create_audio(label: string, file: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.onclick = () => {
    playSound(label);
  };
  button.innerText = label;

  const audio = document.createElement("audio");
  audio.src = file;
  audio.id = label;

  button.appendChild(audio);

  return button;
}

console.log("here I go, rendering again!");

window["ipcComms"].onShowAlert((value) => {
  alert(value);
});

window["ipcComms"].onRefreshPage((value) => {
  location.reload();
});

window["ipcComms"].onPlaySound((value) => {
  playSound(value);
});

window["ipcComms"].onSayWords((value) => {
  sayWords(value);
});

try {
  const root = document.getElementsByTagName("body")[0];
  const audio1 = create_audio("audio 1", "./resources/fail.wav");
  const audio2 = create_audio("audio 2", "./resources/sully-fanfare.ogg");
  const audio3 = create_audio(
    "audio 3",
    "./resources/you-did-something-yay.wav",
  );
  const audio4 = create_audio("audio 4", "./resources/pass.wav");
  const audio5 = create_audio("audio 5", "./resources/oh-oh-icq-sound.mp3");
  const audio6 = create_audio(
    "audio 6",
    "./resources/old-aol-instant-messenger-aim-sound-effects-youtube.mp3",
  );

  const audio7 = create_audio("audio 7", "./resources/guitar-in-d-89205.mp3");

  root.appendChild(audio1);
  root.appendChild(audio2);
  root.appendChild(audio3);
  root.appendChild(audio4);
  root.appendChild(audio5);
  root.appendChild(audio6);
  root.appendChild(audio7);

  sayWords("System Tray Ready");
} catch (e) {
  console.error(e);
  alert("error: " + e.message);
}
