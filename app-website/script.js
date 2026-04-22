(() => {
  const nav = document.getElementById("nav");
  const toggle = document.getElementById("nav-toggle");
  const menu = document.getElementById("mobile-menu");

  // Shadow/border on scroll
  const onScroll = () => {
    if (window.scrollY > 8) nav.classList.add("scrolled");
    else nav.classList.remove("scrolled");
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // Mobile menu
  if (toggle && menu) {
    toggle.addEventListener("click", () => {
      const open = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", String(!open));
      if (open) {
        menu.hidden = true;
        menu.removeAttribute("data-open");
      } else {
        menu.hidden = false;
        menu.setAttribute("data-open", "true");
      }
    });
    menu.querySelectorAll("a").forEach((a) =>
      a.addEventListener("click", () => {
        toggle.setAttribute("aria-expanded", "false");
        menu.hidden = true;
        menu.removeAttribute("data-open");
      }),
    );
  }

  // Copy buttons
  const flashCopied = (btn) => {
    const label = btn.querySelector("span");
    const original = label ? label.textContent : btn.textContent;
    btn.classList.add("copied");
    if (label) label.textContent = "Copied";
    else btn.textContent = "Copied";
    setTimeout(() => {
      btn.classList.remove("copied");
      if (label) label.textContent = original;
      else btn.textContent = original;
    }, 1400);
  };

  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "absolute";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        return true;
      } catch {
        return false;
      } finally {
        document.body.removeChild(ta);
      }
    }
  };

  const heroCopy = document.getElementById("copy-btn");
  const heroCmd = document.getElementById("install-cmd");
  if (heroCopy && heroCmd) {
    heroCopy.addEventListener("click", async () => {
      if (await copyText(heroCmd.textContent.trim())) flashCopied(heroCopy);
    });
  }

  document.querySelectorAll("button.copy[data-copy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const text = btn.getAttribute("data-copy") || "";
      if (await copyText(text)) flashCopied(btn);
    });
  });

  // Reveal-on-scroll
  const targets = document.querySelectorAll(
    ".feature, .flow li, .step, .panel, .section-head, .cta, .install-card",
  );
  targets.forEach((el) => el.classList.add("reveal"));

  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("visible");
            io.unobserve(e.target);
          }
        });
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.1 },
    );
    targets.forEach((el) => io.observe(el));
  } else {
    targets.forEach((el) => el.classList.add("visible"));
  }
})();
