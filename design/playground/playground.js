const device = document.querySelector(".device");
const hdrSub = document.getElementById("hdrSub");

document.querySelectorAll(".state-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".state-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const s = btn.dataset.state;
    device.dataset.state = s;
    if (s === "connected") hdrSub.textContent = "Connected · reverse";
    if (s === "needs-key") hdrSub.textContent = "Needs API key";
    if (s === "offline") hdrSub.textContent = "Executor offline";
  });
});

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const v = tab.dataset.view;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.dataset.view === v));
    document.querySelectorAll(".view").forEach((view) => {
      view.classList.toggle("on", view.dataset.view === v);
    });
  });
});
