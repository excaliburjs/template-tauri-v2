import * as ex from 'excalibur';
import { invoke } from "@tauri-apps/api/core";

const game = new ex.Engine({
  displayMode: ex.DisplayMode.FitScreenAndFill
});
const hello = new ex.Label({
  name: 'Hello',
  text: 'Hello Tauri 2.0! 🦀💖🎉',
  pos: game.screen.center.sub(ex.vec(0, 100)),
  color: ex.Color.White,
  font: new ex.Font({
      family: 'Segoe UI Light',
      size: 50,
      textAlign: ex.TextAlign.Center,
      baseAlign: ex.BaseAlign.Alphabetic
  })
});
(hello.graphics.current as ex.Text).maxWidth = 600;

game.add(hello);
game.start();

let greetInputEl: HTMLInputElement | null;
let greetMsgEl: HTMLElement | null;

async function greet() {
  if (greetMsgEl && greetInputEl) {
    // Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
    const textFromRust = await invoke<string>("greet", {
      name: greetInputEl.value,
    });

    greetMsgEl.textContent = textFromRust;
    hello.text = textFromRust;
  }
}

window.addEventListener("DOMContentLoaded", () => {
  greetInputEl = document.querySelector("#greet-input");
  greetMsgEl = document.querySelector("#greet-msg");
  document.querySelector("#greet-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    greet();
  });
});