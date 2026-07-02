/*
 * MathVid interactive-question engine.
 *
 * A single, generic, framework-free engine that renders any interactive
 * question JSON (see web/engine/README.md for the contract) into accessible,
 * keyboard-navigable, step-by-step HTML. Math is typeset with MathJax v4.
 *
 * The engine reads its data from an inlined
 *   <script type="application/json" id="mathvid-data"> ... </script>
 * and renders into the element with id "mathvid-questions".
 */
(function () {
  "use strict";

  var DATA_ID = "mathvid-data";
  var MOUNT_ID = "mathvid-questions";

  // Resolves once MathJax has finished startup. Falls back gracefully if
  // MathJax never loads (math is left as readable source text).
  var mathReady = new Promise(function (resolve) {
    var tries = 0;
    (function check() {
      if (window.MathJax && window.MathJax.startup && window.MathJax.startup.promise) {
        window.MathJax.startup.promise.then(resolve, resolve);
      } else if (tries++ < 600) {
        window.setTimeout(check, 50);
      } else {
        resolve();
      }
    })();
  });

  function typeset(node) {
    return mathReady
      .then(function () {
        if (window.MathJax && typeof window.MathJax.typesetPromise === "function") {
          return window.MathJax.typesetPromise([node]);
        }
        return null;
      })
      .catch(function (err) {
        if (window.console) window.console.error("MathJax typesetting failed", err);
      });
  }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (key === "className") node.className = value;
        else if (key === "htmlFor") node.htmlFor = value;
        else if (key === "text") node.textContent = value;
        else node.setAttribute(key, value);
      });
    }
    return node;
  }

  function focus(node) {
    if (node && typeof node.focus === "function") node.focus();
  }

  // (a), (b), … (z), (aa), … for accordion part labels.
  function partLabel(index) {
    var label = "";
    var n = index;
    while (n >= 0) {
      label = String.fromCharCode(97 + (n % 26)) + label;
      n = Math.floor(n / 26) - 1;
    }
    return "(" + label + ")";
  }

  // Convert a content node to a MathJax-ready source string. text keeps inline
  // $...$; math and align supply only inner LaTeX, so we add the delimiters.
  function nodeToSource(node) {
    if (node.type === "math") return "\\[" + node.latex + "\\]";
    if (node.type === "align") return "\\begin{align*}" + node.latex + "\\end{align*}";
    return node.latex;
  }

  function renderFigure(node) {
    var figure = el("figure", { className: "mvi-figure" });
    var imgAttrs = {
      className: "mvi-figure-img",
      src: node.src,
      alt: node.alt || "",
      decoding: "async"
    };
    if (node.intrinsicWidth && node.intrinsicHeight) {
      imgAttrs.width = String(node.intrinsicWidth);
      imgAttrs.height = String(node.intrinsicHeight);
    }
    var img = el("img", imgAttrs);
    if (node.width) {
      img.style.maxWidth = node.width;
    }
    figure.appendChild(img);
    return figure;
  }

  function renderContent(nodes, container) {
    (nodes || []).forEach(function (node) {
      var block;
      if (node.type === "text") {
        block = el("p", { className: "mvi-text" });
        block.textContent = nodeToSource(node);
      } else if (node.type === "image") {
        block = renderFigure(node);
      } else if (node.type === "math" || node.type === "align") {
        block = el("div", { className: "mvi-math" });
        block.textContent = nodeToSource(node);
      } else {
        block = el("p", {
          className: "mvi-unsupported",
          text: "Unsupported content block (" + node.type + ")."
        });
      }
      container.appendChild(block);
    });
    return container;
  }

  // Render content that must sit inline (prompts/choice labels/legends) where a
  // block <p> would be wrong. Single text node -> inline; otherwise fall back to
  // block rendering inside the inline container.
  function renderInlineContent(nodes, container) {
    if (nodes && nodes.length === 1 && nodes[0].type === "text") {
      container.appendChild(document.createTextNode(nodes[0].latex));
    } else {
      renderContent(nodes, container);
    }
    return container;
  }

  function feedbackRegion(partId) {
    // role="status" is an implicit polite live region; the explicit aria-live
    // and aria-atomic make the whole message re-announce as one update.
    var region = el("div", {
      className: "mvi-feedback",
      id: partId + "-feedback",
      role: "status",
      "aria-live": "polite",
      "aria-atomic": "true",
      hidden: "hidden"
    });
    region.hidden = true;
    return region;
  }

  function appendInlineFeedback(nodes, container) {
    if (!nodes || !nodes.length) return;
    var explanation = el("span", { className: "mvi-feedback-explanation" });
    explanation.appendChild(document.createTextNode(" "));
    nodes.forEach(function (node) {
      var inline;
      if (node.type === "text") {
        explanation.appendChild(document.createTextNode(node.latex));
      } else if (node.type === "math") {
        inline = el("span", { className: "mvi-math-inline" });
        inline.textContent = "\\(" + node.latex + "\\)";
        explanation.appendChild(inline);
      } else if (node.type === "align") {
        inline = el("span", { className: "mvi-math-inline" });
        inline.textContent = "\\begin{align*}" + node.latex + "\\end{align*}";
        explanation.appendChild(inline);
      } else if (node.type === "image") {
        explanation.appendChild(renderFigure(node));
      } else {
        inline = el("span", {
          className: "mvi-unsupported",
          text: "Unsupported content block (" + node.type + ")."
        });
        explanation.appendChild(inline);
      }
    });
    container.appendChild(explanation);
  }

  function showFeedback(region, status, statusText, nodes) {
    while (region.firstChild) region.removeChild(region.firstChild);
    region.hidden = false;
    region.classList.remove("is-correct", "is-incorrect", "is-neutral");
    region.classList.add(
      status === "correct" ? "is-correct" : status === "incorrect" ? "is-incorrect" : "is-neutral"
    );

    var statusLine = el("p", { className: "mvi-feedback-status" });
    var icon = el("span", { className: "mvi-icon", "aria-hidden": "true" });
    icon.textContent = status === "correct" ? "\u2713" : status === "incorrect" ? "\u2717" : "\u2139";
    var text = el("strong", { className: "mvi-status-text", text: statusText });
    statusLine.appendChild(icon);
    statusLine.appendChild(text);
    appendInlineFeedback(nodes, statusLine);
    region.appendChild(statusLine);
    typeset(region);
  }

  function renderMultipleChoice(part, container, state, onChecked) {
    var fieldset = el("fieldset", { className: "mvi-choices" });
    var legend = el("legend", { className: "mvi-prompt" });
    renderInlineContent(part.prompt, legend);
    fieldset.appendChild(legend);

    var region = feedbackRegion(part.id);
    var choiceById = {};
    var itemById = {};
    var inputs = [];

    // Roving tabindex: the group is a single Tab stop and only the active radio
    // is tabbable; arrow keys move focus between options.
    function setRoving(activeIdx) {
      inputs.forEach(function (inp, i) {
        inp.tabIndex = i === activeIdx ? 0 : -1;
      });
    }

    function focusIndex(i) {
      var n = inputs.length;
      if (!n) return;
      i = (i + n) % n;
      setRoving(i);
      inputs[i].focus();
    }

    // Commit = select AND grade. Triggered only by a pointer click/tap or by
    // Enter/Space on the focused option - never by arrow navigation - so an
    // answer is graded only on a deliberate action.
    function commit(idx) {
      var input = inputs[idx];
      var choice = choiceById[input.value];
      inputs.forEach(function (inp) {
        inp.checked = inp === input;
      });
      Array.prototype.forEach.call(fieldset.querySelectorAll(".mvi-choice"), function (c) {
        c.classList.remove("is-correct", "is-incorrect", "is-selected");
      });
      var item = itemById[input.value];
      item.classList.add("is-selected");
      item.classList.add(choice.correct ? "is-correct" : "is-incorrect");
      setRoving(idx);
      state.selectedChoiceId = input.value;
      state.checked = true;
      state.correct = choice.correct;
      showFeedback(
        region,
        choice.correct ? "correct" : "incorrect",
        choice.correct ? "Correct." : "Incorrect.",
        choice.feedback
      );
      onChecked();
    }

    (part.choices || []).forEach(function (choice, idx) {
      choiceById[choice.id] = choice;
      // The whole card is a <label> wrapping the radio, so the entire visual
      // row is the click/tap target.
      var item = el("label", { className: "mvi-choice" });
      var input = el("input", {
        type: "radio",
        name: part.id + "-choice",
        id: choice.id + "-input",
        value: choice.id,
        className: "mvi-radio"
      });
      var mark = el("span", { className: "mvi-choice-mark", "aria-hidden": "true" });
      var content = el("span", { className: "mvi-choice-content" });
      renderInlineContent(choice.content, content);

      // Pointer (mouse/touch) activation commits immediately. Keyboard commit is
      // handled by the group keydown listener; arrow keys and Enter/Space have
      // their default radio behavior suppressed, so no synthetic click fires
      // here from the keyboard.
      input.addEventListener("click", function () {
        commit(idx);
      });

      item.appendChild(input);
      item.appendChild(mark);
      item.appendChild(content);
      itemById[choice.id] = item;
      inputs.push(input);
      fieldset.appendChild(item);
    });

    setRoving(0);

    fieldset.addEventListener("keydown", function (event) {
      var idx = inputs.indexOf(document.activeElement);
      if (idx === -1) return;
      var key = event.key;
      if (key === "ArrowDown" || key === "ArrowRight") {
        event.preventDefault();
        focusIndex(idx + 1);
      } else if (key === "ArrowUp" || key === "ArrowLeft") {
        event.preventDefault();
        focusIndex(idx - 1);
      } else if (key === "Enter" || key === " " || key === "Spacebar") {
        // Suppress native radio Space (which would check on focus) and use it as
        // the deliberate commit action instead.
        event.preventDefault();
        commit(idx);
      }
    });

    container.appendChild(fieldset);
    container.appendChild(region);
  }

  function renderFillBlank(part, container, state, onChecked) {
    var wrap = el("div", { className: "mvi-fillblank" });
    var label = el("label", { className: "mvi-prompt", htmlFor: part.id + "-input" });
    renderInlineContent(part.prompt, label);
    wrap.appendChild(label);

    var controls = el("div", { className: "mvi-fillblank-controls" });
    var input = el("input", {
      type: "text",
      inputmode: "numeric",
      pattern: "-?[0-9]+",
      autocomplete: "off",
      id: part.id + "-input",
      className: "mvi-input"
    });
    var check = el("button", {
      type: "button",
      className: "mvi-check",
      id: part.id + "-check",
      text: "Check answer"
    });
    var showSolution = el("button", {
      type: "button",
      className: "mvi-show-solution",
      id: part.id + "-solution",
      text: "Show solution"
    });
    controls.appendChild(input);
    controls.appendChild(check);
    controls.appendChild(showSolution);
    wrap.appendChild(controls);

    var region = feedbackRegion(part.id);

    function runShowSolution() {
      showFeedback(region, "neutral", "Solution.", part.feedback.correct);
    }

    function runCheck() {
      var raw = input.value.trim();
      if (!/^-?\d+$/.test(raw)) {
        showFeedback(region, "neutral", "Enter a whole number (an integer).", []);
        return;
      }
      var isCorrect = parseInt(raw, 10) === part.answer;
      state.selectedChoiceId = raw;
      state.checked = true;
      state.correct = isCorrect;
      showFeedback(
        region,
        isCorrect ? "correct" : "incorrect",
        isCorrect ? "Correct." : "Incorrect.",
        isCorrect ? part.feedback.correct : part.feedback.incorrect
      );
      onChecked();
    }

    // Enter in the field submits; the Check button is the pointer/secondary path.
    check.addEventListener("click", runCheck);
    showSolution.addEventListener("click", runShowSolution);
    input.addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        event.preventDefault();
        runCheck();
      }
    });

    container.appendChild(wrap);
    container.appendChild(region);
  }

  // Build one accordion part. All parts are rendered up front; only the
  // "current" part is expanded. Returns a small controller the question uses to
  // drive the sequential-gating state machine.
  //
  // Status values:
  //   not-started - panel hidden, toggle disabled, status reads "Not started".
  //   current     - panel expanded and answerable, summary hidden (no spoiler).
  //   complete    - panel collapsed (re-openable), summary shows the result.
  function renderPart(part, index, total, onAdvance, onExclusiveExpand) {
    var panelId = part.id + "-panel";
    var summaryId = part.id + "-summary";
    var statusId = part.id + "-status";

    // Per-part state. The DOM persists (panels are hidden, never removed), so
    // reopening a part keeps its selection/feedback; this object is the
    // explicit, queryable mirror of that state.
    var state = {
      status: "not-started",
      expanded: false,
      rendered: false,
      selectedChoiceId: null,
      checked: false,
      correct: null
    };

    var partEl = el("div", { className: "mvi-part is-not-started" });

    var heading = el("h3", { className: "mvi-part-heading", id: part.id + "-header" });
    var toggle = el("button", {
      type: "button",
      className: "mvi-part-toggle",
      id: part.id + "-toggle",
      "aria-expanded": "false",
      "aria-controls": panelId,
      // State badge; completed-part result math sits in the button label beside (a).
      "aria-describedby": statusId
    });
    var labelSpan = el("span", { className: "mvi-part-label", text: partLabel(index) });
    toggle.appendChild(labelSpan);
    // Inline beside the part label once complete; empty (and hidden) while in progress.
    var summary = el("span", { className: "mvi-part-summary", id: summaryId });
    toggle.appendChild(summary);
    heading.appendChild(toggle);
    var status = el("span", { className: "mvi-part-status", id: statusId, text: "Not started" });
    heading.appendChild(status);
    partEl.appendChild(heading);

    var panel = el("div", { className: "mvi-part-panel", id: panelId });
    panel.hidden = true;

    var footer = el("div", { className: "mvi-part-footer" });
    var advanceBtn = el("button", {
      type: "button",
      className: "mvi-next",
      text: index + 1 < total ? "Next part" : "Finish"
    });
    advanceBtn.hidden = true;
    advanceBtn.addEventListener("click", function () {
      onAdvance();
    });
    footer.appendChild(advanceBtn);

    function onChecked() {
      advanceBtn.hidden = false;
    }

    if (part.type === "multiple_choice") {
      renderMultipleChoice(part, panel, state, onChecked);
    } else if (part.type === "fill_blank_integer") {
      renderFillBlank(part, panel, state, onChecked);
    } else {
      panel.appendChild(el("p", { className: "mvi-unsupported", text: "Unsupported question part." }));
    }
    panel.appendChild(footer);
    partEl.appendChild(panel);

    // Typeset the panel lazily on first expand so MathJax never measures
    // hidden (display:none) content, which mis-measures CHTML layout.
    function setExpanded(expanded) {
      state.expanded = expanded;
      toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
      panel.hidden = !expanded;
      if (expanded) {
        if (state.checked) {
          advanceBtn.hidden = false;
          advanceBtn.disabled = false;
        }
        if (!state.rendered) {
          state.rendered = true;
          typeset(panel);
        }
      }
    }

    function renderSummary() {
      while (summary.firstChild) summary.removeChild(summary.firstChild);
      if (part.summary && part.summary.length) {
        renderInlineContent(part.summary, summary);
        typeset(summary);
      }
    }

    var STATUS_LABELS = {
      "not-started": "Not started",
      current: "Current",
      complete: "Complete"
    };

    function setState(next) {
      state.status = next;
      partEl.className = "mvi-part is-" + next;
      status.textContent = STATUS_LABELS[next];
      if (next === "not-started") {
        toggle.setAttribute("aria-disabled", "true");
        setExpanded(false);
      } else if (next === "current") {
        toggle.removeAttribute("aria-disabled");
        onExclusiveExpand();
        setExpanded(true);
      } else if (next === "complete") {
        toggle.removeAttribute("aria-disabled");
        renderSummary();
        if (state.checked) {
          advanceBtn.hidden = false;
          advanceBtn.disabled = false;
        }
        setExpanded(false);
      }
    }

    toggle.addEventListener("click", function () {
      if (state.status === "not-started") return;
      var willExpand = toggle.getAttribute("aria-expanded") !== "true";
      if (willExpand) onExclusiveExpand();
      setExpanded(willExpand);
    });

    return {
      el: partEl,
      setState: setState,
      setExpanded: setExpanded,
      isExpanded: function () { return state.expanded; },
      focusToggle: function () { focus(toggle); }
    };
  }

  function renderQuestion(question, index, mount) {
    var section = el("section", {
      className: "mvi-question",
      "aria-labelledby": question.id + "-heading"
    });
    var heading = el("h2", {
      className: "mvi-question-heading",
      id: question.id + "-heading",
      tabindex: "-1",
      text: "Interactive Problem " + (index + 1)
    });
    section.appendChild(heading);

    var stem = renderContent(question.stem, el("div", { className: "mvi-stem" }));
    section.appendChild(stem);

    var partsContainer = el("div", { className: "mvi-parts-accordion" });
    section.appendChild(partsContainer);

    var parts = question.parts || [];
    var controllers = [];

    // Conclusion is rendered lazily when reached, so MathJax never typesets
    // hidden (display:none) content, which can mis-measure CHTML layout.
    function showConclusion() {
      if (!(question.conclusion && question.conclusion.length)) return;
      if (section.querySelector(".mvi-conclusion")) return;
      var conclusionEl = el("div", { className: "mvi-conclusion" });
      conclusionEl.appendChild(
        el("h3", { className: "mvi-conclusion-heading", tabindex: "-1", text: "Summary" })
      );
      renderContent(question.conclusion, conclusionEl);
      section.appendChild(conclusionEl);
      typeset(conclusionEl);
      focus(conclusionEl.querySelector(".mvi-conclusion-heading"));
    }

    parts.forEach(function (part, i) {
      var controller;
      controller = renderPart(
        part,
        i,
        parts.length,
        function advance() {
          controller.setState("complete");
          if (i + 1 < parts.length) {
            controllers[i + 1].setState("current");
            controllers[i + 1].focusToggle();
          } else {
            showConclusion();
          }
        },
        function exclusiveExpand() {
          controllers.forEach(function (other) {
            if (other !== controller && other.isExpanded()) {
              other.setExpanded(false);
            }
          });
        }
      );
      controllers.push(controller);
      partsContainer.appendChild(controller.el);
    });

    mount.appendChild(section);

    // First part starts expanded (and typeset); the rest stay "Not started"
    // until sequentially unlocked.
    controllers.forEach(function (controller, i) {
      controller.setState(i === 0 ? "current" : "not-started");
    });

    typeset(stem);
  }

  function render(data, mount) {
    var questions = (data && data.questions) || [];
    questions.forEach(function (question, index) {
      renderQuestion(question, index, mount);
    });
  }

  function init() {
    var mount = document.getElementById(MOUNT_ID);
    var dataEl = document.getElementById(DATA_ID);
    if (!mount || !dataEl) return;

    var data;
    try {
      data = JSON.parse(dataEl.textContent);
    } catch (err) {
      if (window.console) window.console.error("Could not parse interactive question data", err);
      return;
    }
    render(data, mount);
    // Visible math (stems and each first/current part) is typeset by
    // renderQuestion; collapsed panels, summaries, and conclusions typeset
    // lazily as they expand so MathJax never measures hidden CHTML.
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Exposed for testing / manual re-rendering.
  window.MathVidInteractive = { render: render, init: init };
})();
