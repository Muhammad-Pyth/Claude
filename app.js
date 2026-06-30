// ── State ──
var currentBookId = null;
var books = [];
var currentBookStructure = [];
var tashkeelVisible = true;
var currentSlidesData = [];   // [{number, html}] for the open book, cached for instant tashkeel toggling
var renderToken = 0;          // bumped whenever we (re)start rendering, so stale async work can bail out
var CHUNK_SIZE = 40;          // slides rendered per progressive batch (keeps huge books from freezing the tab)
var searchScope = 'all';
// 'nav' (default): search box matches book titles + heading text, library-
//   wide, with the current/all scope options hidden (a quick-jump index).
// 'content': matches page body text only, scoped by current/all — entered
//   by toggling the بحث button, which trades title/heading matching away
//   for scoped full-text search.
var searchMode = 'nav';

// Arabic diacritics (tashkeel) range — matches the same characters the
// server strips for search normalization, so toggling is predictable.
var TASHKEEL_REGEX = /[\u064B-\u065F\u0670]/g;

// ── DOM Elements ──
var bookTree = document.getElementById('book-tree');
var bookContent = document.getElementById('book-content');
var welcome = document.getElementById('welcome');
var reader = document.getElementById('reader');
var sidebar = document.getElementById('sidebar');
var layoutSplitter = document.getElementById('layout-splitter');
var sidebarSearchInput = document.getElementById('sidebar-search-input');
var sidebarSearchClear = document.getElementById('sidebar-search-clear');
var sidebarSearchResults = document.getElementById('sidebar-search-results');
var sidebarSearchScope = document.querySelector('.sidebar-search-scope');
var tocSearchInput = document.getElementById('toc-search-input');
var tocSearchClear = document.getElementById('toc-search-clear');
var btnSearchToggle = document.getElementById('btn-search-toggle');
var aiPanel = document.getElementById('ai-panel');
var aiMessages = document.getElementById('ai-messages');
var aiInput = document.getElementById('ai-input');
var aiAgentSelect = document.getElementById('ai-agent');
var fontSelector = document.getElementById('font-selector');

// ── Init ──
document.addEventListener('DOMContentLoaded', function() {
    setupEventListeners();
    setupFontSwitcher();
    setupTashkeelToggle();
    setupSidebarSearch();
    setupTOCSearch();
    setupSplitter();
    setupSessionRestore();
    loadBooks().then(restoreLastSession);
});

// ── Event Listeners ──
function setupEventListeners() {
    document.getElementById('btn-refresh').addEventListener('click', function() { refreshLibrary(false); });
    document.getElementById('btn-refresh-full').addEventListener('click', function() {
        if (confirm('سيُعاد فهرسة جميع الكتب من جديد، وقد يستغرق ذلك وقتاً أطول من التحديث العادي. هل تريد الاستمرار؟')) {
            refreshLibrary(true);
        }
    });
    // بحث toggles between two search modes: by default the search box is a
    // quick title/heading index (no scope options, always library-wide);
    // toggling reveals the current-book/whole-library scope options and
    // switches to scoped full-text page-content search instead.
    document.getElementById('btn-search-toggle').addEventListener('click', toggleContentSearchMode);
    document.getElementById('btn-ai-toggle').addEventListener('click', function() { toggleAI(true); });
    document.getElementById('close-ai').addEventListener('click', function() { toggleAI(false); });
    document.getElementById('btn-send-ai').addEventListener('click', sendAIQuestion);

    aiInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendAIQuestion();
        }
    });
}

// ── Font Switcher ──
function setupFontSwitcher() {
    fontSelector.addEventListener('change', function(e) {
        var font = e.target.value;
        document.documentElement.style.setProperty('--font-body', '"' + font + '", serif');
        document.documentElement.style.setProperty('--font-heading', '"' + font + '", serif');
    });
}

// ── Tashkeel Toggle ──
// Re-renders the already-fetched slide HTML through a single cheap regex
// pass instead of walking the DOM tree node-by-node. The reader's reading
// position is preserved by remembering exactly which slide sits at the top
// of the viewport (and how far scrolled into it) *before* toggling, then
// restoring that exact spot once the same slide exists again in the
// rebuilt DOM — not by guessing from a height ratio. A ratio measured
// against `reader.scrollHeight` is only correct once the *entire* book has
// re-rendered, but slides stream in progressively in the background; the
// previous implementation read that ratio almost immediately, while only
// the first ~40 slides existed, so the restored position drifted further
// the deeper the reader had scrolled into the book — exactly the "jumps to
// another location, sometimes considerably" symptom.
function setupTashkeelToggle() {
    var btn = document.getElementById('btn-tashkeel');
    if (!btn) return;

    btn.addEventListener('click', function() {
        tashkeelVisible = !tashkeelVisible;
        btn.classList.toggle('active-toggle', !tashkeelVisible);
        btn.textContent = tashkeelVisible ? '◌ التشكيل' : '◌ بدون تشكيل';

        if (!currentSlidesData.length) return;

        var anchor = getCurrentTopSlideInfo();

        renderToken++;
        var myToken = renderToken;
        // `silent: true` tells renderAllSlides to still synchronously include
        // the anchor slide in the first chunk (so its real post-toggle
        // position is known right away) without also kicking off its own
        // animated scrollIntoView — we restore the exact pixel offset
        // ourselves immediately below instead.
        renderAllSlides(myToken, anchor ? { type: 'slide', value: anchor.slideNumber, silent: true } : null);

        if (anchor) {
            restoreScrollOffset(anchor, myToken);
        }
    });
}

// Finds the slide currently sitting at (or just above) the top of the
// visible reader area, plus how many pixels the reader has already
// scrolled into it.
function getCurrentTopSlideInfo() {
    var slideEls = bookContent.querySelectorAll('.slide-page');
    if (!slideEls.length) return null;
    var readerTop = reader.getBoundingClientRect().top;
    var best = slideEls[0];
    var bestOffset = 0;
    for (var i = 0; i < slideEls.length; i++) {
        var rect = slideEls[i].getBoundingClientRect();
        if (rect.top - readerTop <= 1) {
            best = slideEls[i];
            bestOffset = readerTop - rect.top;
        } else {
            break;
        }
    }
    return { slideNumber: parseInt(best.dataset.slideNumber, 10), offset: Math.max(0, bestOffset) };
}

// Instantly (no animation) restores the reader's scroll position to the
// spot recorded by getCurrentTopSlideInfo(), once that slide exists in the
// freshly-rebuilt DOM.
function restoreScrollOffset(anchor, token, attemptsLeft) {
    attemptsLeft = attemptsLeft === undefined ? 40 : attemptsLeft;
    if (token !== renderToken) return; // superseded by a newer render
    var el = bookContent.querySelector('[data-slide-number="' + anchor.slideNumber + '"]');
    if (el) {
        // .slide-page's offsetParent is #reader itself (the nearest
        // positioned ancestor — #book-content in between is static), so
        // offsetTop is already in the same coordinate space as scrollTop.
        reader.scrollTop = el.offsetTop + (anchor.offset || 0);
        return;
    }
    if (attemptsLeft <= 0) return;
    setTimeout(function() { restoreScrollOffset(anchor, token, attemptsLeft - 1); }, 20);
}

// ── Session Restoration ──
// Remembers which book was open and exactly where the reader had scrolled
// to, so reloading or reopening the app resumes at the same spot instead
// of always landing back on the welcome screen. Reuses the same
// "topmost visible slide + pixel offset into it" anchor the tashkeel
// toggle uses, for the same reason: it's a real, stable position rather
// than a height-ratio that drifts as content streams in.
var SESSION_KEY = 'lastReadingSession';

function saveSession() {
    if (!currentBookId || !currentSlidesData.length) return;
    var anchor = getCurrentTopSlideInfo();
    if (!anchor) return;
    try {
        localStorage.setItem(SESSION_KEY, JSON.stringify({
            bookId: currentBookId,
            slideNumber: anchor.slideNumber,
            offset: anchor.offset
        }));
    } catch (e) { /* localStorage unavailable — restoration just won't happen next time */ }
}

function setupSessionRestore() {
    reader.addEventListener('scroll', debounce(saveSession, 400));
}

// Called once, after the library has loaded and the tree is rendered.
function restoreLastSession() {
    var raw;
    try { raw = localStorage.getItem(SESSION_KEY); } catch (e) { return; }
    if (!raw) return;

    var session;
    try { session = JSON.parse(raw); } catch (e) { return; }
    if (!session || !session.bookId) return;

    // The book might have been removed/renamed since the last session.
    var stillExists = books.some(function(b) { return b.id === session.bookId; });
    if (!stillExists) return;

    document.querySelectorAll('.tree-node.active').forEach(function(n) { n.classList.remove('active'); });
    var node = bookTree.querySelector('.tree-node[data-book-id="' + session.bookId + '"]');
    if (node) node.classList.add('active');

    currentBookId = session.bookId;
    welcome.classList.add('hidden');
    bookContent.classList.remove('hidden');
    bookContent.innerHTML = '<div class="loading-msg">جارٍ استرجاع آخر موضع قراءة...</div>';

    renderToken++;
    var myToken = renderToken;

    fetch('/api/books/' + session.bookId + '/content')
        .then(function(res) { return res.json(); })
        .then(function(slides) {
            if (myToken !== renderToken) return;
            currentSlidesData = slides || [];
            // silent: true — land exactly on the saved pixel offset below,
            // without also triggering a separate animated scrollIntoView.
            renderAllSlides(myToken, { type: 'slide', value: session.slideNumber, silent: true });
            restoreScrollOffset({ slideNumber: session.slideNumber, offset: session.offset || 0 }, myToken);
        })
        .catch(function(err) {
            console.error('Failed to restore last reading session:', err);
        });
}

function stripTashkeel(html) {
    return html.replace(TASHKEEL_REGEX, '');
}

function buildSlideHtml(slide) {
    var html = tashkeelVisible ? slide.html : stripTashkeel(slide.html);
    return '<div class="slide-page" data-slide-number="' + slide.number + '">' + html + '</div>';
}

// ── Library Loading ──
function loadBooks() {
    return fetch('/api/books')
        .then(function(res) { return res.json(); })
        .then(function(data) {
            books = data;
            renderBookTree();
        })
        .catch(function(err) {
            console.error('Failed to load books:', err);
            bookTree.innerHTML = '<div class="empty-msg">تعذر تحميل المكتبة. تأكد من تشغيل الخادم.</div>';
        });
}

function refreshLibrary(forceFull) {
    var btn = document.getElementById('btn-refresh');
    btn.disabled = true;
    document.getElementById('btn-refresh-full').disabled = true;
    btn.classList.add('active-toggle');
    btn.innerHTML = '<span class="spinner"></span> جارٍ التحديث...';

    var url = '/api/refresh' + (forceFull ? '?full=1' : '');

    fetch(url, { method: 'POST' })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (data.status === 'error') {
                alert('حدث خطأ أثناء تحديث المكتبة:\n' + data.message);
                return;
            }
            if (data.missing_dir) {
                alert('لم يتم العثور على مجلد "books" بجانب البرنامج. أضف كتبك إليه ثم أعد التحديث.');
                return;
            }
            loadBooks();
            var msg = 'تم تحديث المكتبة (' + data.total + ' ملف).\n' +
                'جديد: ' + data.added + '   معدَّل: ' + data.updated +
                '   بلا تغيير: ' + data.unchanged + '   محذوف: ' + data.removed;
            if (data.errors > 0) msg += '\nتعذرت معالجة ' + data.errors + ' ملف(ات) — راجع نافذة التشغيل لتفاصيل الخطأ.';
            if (data.embedded > 0) msg += '\nتم إنشاء ' + data.embedded + ' تمثيلاً دلالياً (embeddings) جديداً.';
            if (data.embedding_failed) {
                msg += '\nتعذر إنشاء التمثيلات الدلالية (تحقق من مفتاح API في config.ini) — ' +
                    data.embedding_skipped + ' صفحة لم تُعالَج، وسيُعاد المحاولة في التحديث القادم. ' +
                    'سؤال الذكاء الاصطناعي ما زال يعمل عبر البحث النصي بدلاً من ذلك.';
            }
            alert(msg);
        })
        .catch(function(err) {
            console.error('Refresh error:', err);
            alert('تعذر الاتصال بالخادم. تأكد من تشغيله.');
        })
        .finally(function() {
            btn.disabled = false;
            document.getElementById('btn-refresh-full').disabled = false;
            btn.classList.remove('active-toggle');
            btn.textContent = 'تحديث المكتبة';
        });
}

// ── Tree Rendering ──
function renderBookTree() {
    bookTree.innerHTML = '';
    if (books.length === 0) {
        bookTree.innerHTML = '<div class="empty-msg">لا توجد كتب في المجلد. أضف ملفات HTML إلى مجلد books ثم اضغط "تحديث المكتبة".</div>';
        return;
    }

    books.forEach(function(book) {
        var node = createTreeNode(book);
        bookTree.appendChild(node);
    });
}

function createTreeNode(book) {
    var node = document.createElement('div');
    node.className = 'tree-node';
    node.dataset.bookId = book.id;

    var toggle = document.createElement('div');
    toggle.className = 'tree-toggle';

    var arrow = document.createElement('span');
    arrow.className = 'tree-arrow';
    arrow.textContent = '◄';

    var label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = book.title;

    var dbIndicator = document.createElement('span');
    dbIndicator.className = 'db-indicator';
    if (book.has_db) {
        dbIndicator.textContent = '\ud83d\udcda';
        dbIndicator.title = 'قاعدة بيانات مرتبطة';
    } else {
        dbIndicator.textContent = '\u274c';
        dbIndicator.title = 'لا توجد قاعدة بيانات';
        dbIndicator.style.opacity = '0.5';
    }

    toggle.appendChild(arrow);
    toggle.appendChild(label);
    toggle.appendChild(dbIndicator);
    node.appendChild(toggle);

    var children = document.createElement('div');
    children.className = 'tree-children';
    node.appendChild(children);

    var loaded = false;
    var expanded = false;

    toggle.addEventListener('click', function() {
        if (!loaded) {
            loadBookStructure(book.id, children).then(function() {
                loaded = true;
                expanded = true;
                children.classList.add('open');
                arrow.classList.add('expanded');
            });
        } else {
            expanded = !expanded;
            children.classList.toggle('open', expanded);
            arrow.classList.toggle('expanded', expanded);
        }

        if (!node.classList.contains('active')) {
            document.querySelectorAll('.tree-node.active').forEach(function(n) { n.classList.remove('active'); });
            node.classList.add('active');
            loadBookContent(book.id);
        }
    });

    return node;
}

function loadBookStructure(bookId, container) {
    return fetch('/api/books/' + bookId + '/structure')
        .then(function(res) { return res.json(); })
        .then(function(headings) {
            currentBookStructure = headings;
            renderStructureContainer(bookId, container, headings);
        })
        .catch(function(err) {
            renderStructureContainer(bookId, container, []);
        });
}

function renderStructureContainer(bookId, container, headings) {
    container.innerHTML = '';

    var actionRow = document.createElement('div');
    actionRow.className = 'tree-actions';

    var importRow = document.createElement('div');
    importRow.className = 'tree-import-toc';
    importRow.textContent = '⤓ استيراد الفهرس من الشاملة';
    importRow.title = 'يجلب فهرس الفصول/الأبواب الكامل من shamela.ws ويربطه بصفحات هذا الكتاب';
    importRow.addEventListener('click', function(e) {
        e.stopPropagation();
        runShamelaImport(bookId, container);
    });
    actionRow.appendChild(importRow);

    // Find the book data to check has_db
    var bookData = books.find(function(b) { return b.id === bookId; });
    if (!bookData || !bookData.has_db) {
        var linkDbRow = document.createElement('div');
        linkDbRow.className = 'tree-link-db';
        linkDbRow.textContent = '🗃️ ربط قاعدة بيانات';
        linkDbRow.title = 'رفع ملف .db يدوياً لربطه بهذا الكتاب';
        linkDbRow.addEventListener('click', function(e) {
            e.stopPropagation();
            uploadDbFile(bookId, container);
        });
        actionRow.appendChild(linkDbRow);
    }

    container.appendChild(actionRow);

    if (!headings || headings.length === 0) {
        var empty = document.createElement('div');
        empty.className = 'empty-msg';
        empty.style.padding = '8px';
        empty.style.fontSize = '0.85rem';
        empty.textContent = 'لا يوجد فهرس لهذا الكتاب';
        container.appendChild(empty);
        return;
    }

    headings.forEach(function(h) {
        var div = document.createElement('div');
        div.className = 'tree-heading level-' + h.level;
        div.dataset.headingId = h.id;
        div.textContent = h.text;
        div.addEventListener('click', function(e) {
            e.stopPropagation();
            navigateToHeading(bookId, h);
            setActiveHeading(h.id);
        });
        container.appendChild(div);
    });
}

// Keeps the most recently clicked TOC heading visually distinguished from
// the rest while its page is being read, by toggling a dedicated
// .active-heading class (separate from the .active class used for the
// currently-open book in the tree).
var currentActiveHeadingId = null;

function setActiveHeading(headingId) {
    if (currentActiveHeadingId) {
        var prevHeading = bookTree.querySelector('.tree-heading[data-heading-id="' + currentActiveHeadingId + '"]');
        if (prevHeading) {
            prevHeading.classList.remove('active-heading');
        }
    }
    currentActiveHeadingId = headingId;
    var heading = bookTree.querySelector('.tree-heading[data-heading-id="' + headingId + '"]');
    if (heading) {
        heading.classList.add('active-heading');
    }
}

// Real <h1-6>/data-type="title" headings carry an anchor inside the page
// itself; headings imported from shamela.ws don't (we only know which
// page they start on), so they fall back to scrolling to that whole page.
function navigateToHeading(bookId, h) {
    var target = h.anchor ? { type: 'anchor', value: h.anchor } : { type: 'slide', value: h.slide_number };
    jumpWithinOrLoad(bookId, target);
}

// If the requested book is already open, just jump to the target within
// it (instant — no network round-trip); otherwise load it fresh.
function jumpWithinOrLoad(bookId, jumpTarget) {
    if (currentBookId === bookId && currentSlidesData.length) {
        if (!jumpTarget) {
            clearHighlights();
            reader.scrollTop = 0;
            setTimeout(saveSession, 150);
        } else if (jumpTarget.type === 'anchor') {
            scrollToAnchorWhenReady(jumpTarget.value, undefined, jumpTarget.words);
        } else if (jumpTarget.type === 'slide') {
            scrollToSlideWhenReady(jumpTarget.value, undefined, jumpTarget.words);
        }
    } else {
        loadBookContent(bookId, jumpTarget);
    }
}

// Activates a book's tree node (highlighting it, even while hidden behind
// the search-results panel) and jumps to it. Shared by search-result
// clicks and anything else that needs to open a book from outside the tree.
function openBookById(bookId, jumpTarget) {
    document.querySelectorAll('.tree-node.active').forEach(function(n) { n.classList.remove('active'); });
    var node = bookTree.querySelector('.tree-node[data-book-id="' + bookId + '"]');
    if (node) node.classList.add('active');
    jumpWithinOrLoad(bookId, jumpTarget);
}

// ── Manual DB Upload ──
function uploadDbFile(bookId, container) {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.db';
    input.onchange = function(e) {
        var file = e.target.files[0];
        if (!file) return;

        var form = new FormData();
        form.append('db_file', file);

        var linkRow = container.querySelector('.tree-link-db');
        if (linkRow) {
            linkRow.textContent = 'جارٍ الرفع...';
            linkRow.classList.add('loading');
        }

        fetch('/api/books/' + bookId + '/link_db', {
            method: 'POST',
            body: form
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (data.status === 'ok') {
                alert('تم ربط قاعدة البيانات بنجاح');
                loadBooks(); // Refresh to update indicators
            } else {
                alert('خطأ: ' + (data.message || 'فشل في ربط القاعدة'));
            }
        })
        .catch(function(err) {
            alert('تعذر الاتصال بالخادم');
        })
        .finally(function() {
            if (linkRow) {
                linkRow.textContent = '🗃️ ربط قاعدة بيانات';
                linkRow.classList.remove('loading');
            }
        });
    };
    input.click();
}

function runShamelaImport(bookId, container) {
    var input = prompt('أدخل رقم الكتاب على موقع الشاملة (shamela.ws) أو رابط الكتاب كاملاً:\nمثال: 2864 أو https://shamela.ws/book/2864');
    if (!input || !input.trim()) return;

    var importRow = container.querySelector('.tree-import-toc');
    if (importRow) {
        importRow.textContent = 'جارٍ الاستيراد...';
        importRow.classList.add('loading');
    }

    fetch('/api/books/' + bookId + '/import_toc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shamela_id: input.trim() })
    })
    .then(function(res) {
        return res.json().then(function(data) { return { ok: res.ok, data: data }; });
    })
    .then(function(result) {
        if (!result.ok || result.data.status === 'error') {
            alert('تعذر الاستيراد:\n' + (result.data.message || 'خطأ غير معروف'));
            if (importRow) { importRow.textContent = '⤓ استيراد الفهرس من الشاملة'; importRow.classList.remove('loading'); }
            return;
        }

        var d = result.data;
        var msg = 'تم استيراد ' + d.matched + ' من ' + d.total + ' عنصراً من فهرس الشاملة' +
            (d.part ? (' (الجزء: ' + d.part + ')') : '') + '.';

        if (d.exact !== undefined && d.synthetic !== undefined) {
            msg += '\n(' + d.exact + ' مطابقة مباشرة بترقيم الصفحة، ' + d.synthetic + ' عبر تموضع تقديري داخل الصفحة)';
        }
        if (d.unmatched > 0) {
            msg += '\n' + d.unmatched + ' عنصراً لم يُطابَق - قد يكون ترقيم الصفحات مختلفاً.';
        }

        alert(msg);
        loadBookStructure(bookId, container);
    })
    .catch(function(err) {
        alert('تعذر الاتصال بالخادم أو بموقع الشاملة.');
        if (importRow) { importRow.textContent = '⤓ استيراد الفهرس من الشاملة'; importRow.classList.remove('loading'); }
    });
}

// ── Book Content Loading ──
// jumpTarget (optional): { type: 'anchor'|'slide', value, words?, silent? }
function loadBookContent(bookId, jumpTarget) {
    currentBookId = bookId;
    welcome.classList.add('hidden');
    bookContent.classList.remove('hidden');
    bookContent.innerHTML = '<div class="loading-msg">جارٍ تحميل الكتاب...</div>';

    if (currentActiveHeadingId) {
        var prevHeading = bookTree.querySelector('.tree-heading[data-heading-id="' + currentActiveHeadingId + '"]');
        if (prevHeading) {
            prevHeading.classList.remove('active-heading');
        }
        currentActiveHeadingId = null;
    }

    renderToken++;
    var myToken = renderToken;

    fetch('/api/books/' + bookId + '/content')
        .then(function(res) { return res.json(); })
        .then(function(slides) {
            if (myToken !== renderToken) return; // a newer load started meanwhile
            currentSlidesData = slides || [];
            renderAllSlides(myToken, jumpTarget);
            setTimeout(saveSession, 150);
        })
        .catch(function(err) {
            console.error('Error loading book:', err);
            bookContent.innerHTML = '<div class="error-msg">تعذر تحميل الكتاب</div>';
        });
}

// Renders the first batch of slides immediately (instant first paint even
// for very large books), then appends the rest in small batches via
// setTimeout so the browser stays responsive instead of freezing on one
// giant DOM insertion.
function renderAllSlides(token, jumpTarget) {
    var slides = currentSlidesData;
    if (!slides.length) {
        bookContent.innerHTML = '<div class="empty-msg">لا يوجد محتوى في هذا الكتاب</div>';
        return;
    }

    var firstChunkSize = CHUNK_SIZE;
    if (jumpTarget && jumpTarget.type === 'slide') {
        firstChunkSize = Math.max(firstChunkSize, jumpTarget.value + 3);
    }

    var firstChunk = slides.slice(0, firstChunkSize);
    bookContent.innerHTML = firstChunk.map(buildSlideHtml).join('');

    if (jumpTarget && !jumpTarget.silent) {
        if (jumpTarget.type === 'anchor') {
            scrollToAnchorWhenReady(jumpTarget.value, undefined, jumpTarget.words);
        } else if (jumpTarget.type === 'slide') {
            scrollToSlideWhenReady(jumpTarget.value, undefined, jumpTarget.words);
        }
    }

    if (slides.length > firstChunkSize) {
        appendRemainingChunks(slides, firstChunkSize, token);
    }
}

function appendRemainingChunks(slides, startIndex, token) {
    if (token !== renderToken) return; // cancelled — user switched books or toggled tashkeel again
    var end = Math.min(startIndex + CHUNK_SIZE, slides.length);
    var html = slides.slice(startIndex, end).map(buildSlideHtml).join('');
    bookContent.insertAdjacentHTML('beforeend', html);
    if (end < slides.length) {
        setTimeout(function() { appendRemainingChunks(slides, end, token); }, 0);
    }
}

function scrollToAnchorWhenReady(anchorId, attemptsLeft, words) {
    attemptsLeft = attemptsLeft === undefined ? 40 : attemptsLeft;
    var el = document.getElementById(anchorId);
    if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        var slideEl = el.closest ? el.closest('.slide-page') : null;
        if (words && words.length && slideEl) {
            highlightInSlide(slideEl, words);
        } else {
            clearHighlights();
        }
        setTimeout(saveSession, 300);
        return;
    }
    if (attemptsLeft <= 0) return;
    setTimeout(function() { scrollToAnchorWhenReady(anchorId, attemptsLeft - 1, words); }, 50);
}

function scrollToSlideWhenReady(slideNumber, attemptsLeft, words) {
    attemptsLeft = attemptsLeft === undefined ? 40 : attemptsLeft;
    var el = bookContent.querySelector('[data-slide-number="' + slideNumber + '"]');
    if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        if (words && words.length) {
            highlightInSlide(el, words);
        } else {
            clearHighlights();
        }
        setTimeout(saveSession, 300);
        return;
    }
    if (attemptsLeft <= 0) return;
    setTimeout(function() { scrollToSlideWhenReady(slideNumber, attemptsLeft - 1, words); }, 50);
}

// ── Search-term highlighting ──
// Mirrors the diacritic/letter-variant-tolerant matching used server-side
// for snippet generation (see build_highlight_regex in app.py), so a word
// highlighted in a result snippet is found and highlighted the same way on
// the actual page after navigating to it.
var ALEF_CLASS = '[اأإآ]';
var YAA_CLASS = '[يى]';
var TASHKEEL_CLASS_SRC = '[\\u064B-\\u065F\\u0670\\u0640]*';

function escapeRegexChar(ch) {
    return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function charClassForHighlight(ch) {
    if (ch === 'ا') return ALEF_CLASS;
    if (ch === 'ي') return YAA_CLASS;
    return escapeRegexChar(ch);
}

function buildHighlightRegex(words) {
    if (!words || !words.length) return null;
    var patterns = [];
    for (var i = 0; i < words.length; i++) {
        var w = words[i];
        if (!w) continue;
        var chars = [];
        for (var j = 0; j < w.length; j++) chars.push(charClassForHighlight(w[j]));
        if (chars.length) patterns.push(chars.join(TASHKEEL_CLASS_SRC));
    }
    if (!patterns.length) return null;
    try {
        return new RegExp('(?:' + patterns.join('|') + ')', 'g');
    } catch (e) {
        return null;
    }
}

function clearHighlights() {
    var marks = bookContent.querySelectorAll('mark.search-hit');
    marks.forEach(function(m) {
        var parent = m.parentNode;
        if (!parent) return;
        parent.replaceChild(document.createTextNode(m.textContent), m);
        parent.normalize();
    });
}

function highlightInSlide(slideEl, words) {
    clearHighlights();
    var regex = buildHighlightRegex(words);
    if (!regex) return;

    var walker = document.createTreeWalker(slideEl, NodeFilter.SHOW_TEXT, null, false);
    var textNodes = [];
    var node;
    while ((node = walker.nextNode())) {
        regex.lastIndex = 0;
        if (node.nodeValue && regex.test(node.nodeValue)) textNodes.push(node);
    }

    var firstMark = null;
    textNodes.forEach(function(textNode) {
        var text = textNode.nodeValue;
        regex.lastIndex = 0;
        var lastIndex = 0;
        var frag = document.createDocumentFragment();
        var m, found = false;
        while ((m = regex.exec(text))) {
            found = true;
            if (m.index > lastIndex) frag.appendChild(document.createTextNode(text.slice(lastIndex, m.index)));
            var markEl = document.createElement('mark');
            markEl.className = 'search-hit';
            markEl.textContent = m[0];
            frag.appendChild(markEl);
            if (!firstMark) firstMark = markEl;
            lastIndex = m.index + m[0].length;
            if (m[0].length === 0) regex.lastIndex++;
        }
        if (!found) return;
        if (lastIndex < text.length) frag.appendChild(document.createTextNode(text.slice(lastIndex)));
        textNode.parentNode.replaceChild(frag, textNode);
    });

    if (firstMark) {
        setTimeout(function() {
            firstMark.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 60);
    }
}

// ── Draggable sidebar splitter ──
function setupSplitter() {
    if (!layoutSplitter || !sidebar) return;

    try {
        var saved = localStorage.getItem('sidebarWidth');
        if (saved) sidebar.style.width = saved;
    } catch (e) { /* localStorage unavailable — fine, just use the default width */ }

    var dragging = false, startX = 0, startWidth = 0;

    layoutSplitter.addEventListener('pointerdown', function(e) {
        dragging = true;
        startX = e.clientX;
        startWidth = sidebar.getBoundingClientRect().width;
        layoutSplitter.classList.add('dragging');
        document.body.style.userSelect = 'none';
        if (layoutSplitter.setPointerCapture) {
            try { layoutSplitter.setPointerCapture(e.pointerId); } catch (e2) {}
        }
    });

    layoutSplitter.addEventListener('pointermove', function(e) {
        if (!dragging) return;
        // The sidebar is docked at the right edge of the layout; moving the
        // pointer toward the reader (left) should widen it.
        var delta = startX - e.clientX;
        var newWidth = Math.max(260, Math.min(600, startWidth + delta));
        sidebar.style.width = newWidth + 'px';
    });

    function endDrag() {
        if (!dragging) return;
        dragging = false;
        layoutSplitter.classList.remove('dragging');
        document.body.style.userSelect = '';
        try { localStorage.setItem('sidebarWidth', sidebar.style.width); } catch (e) {}
    }
    layoutSplitter.addEventListener('pointerup', endDrag);
    layoutSplitter.addEventListener('pointercancel', endDrag);
}

// ── Sidebar Search ──
// Lives permanently in the sidebar (replacing the old popup): searches book
// titles, imported/inline TOC headings, and page body text, with yellow-
// highlighted snippets. Clicking a result navigates to it but deliberately
// leaves the results panel exactly as it was, so it can be revisited
// afterwards to try other results without re-searching.
function setupSidebarSearch() {
    document.querySelectorAll('.scope-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
            document.querySelectorAll('.scope-btn').forEach(function(b) { b.classList.remove('active'); });
            btn.classList.add('active');
            searchScope = btn.dataset.scope;
            var q = sidebarSearchInput.value.trim();
            if (q.length >= 2) performSidebarSearch(q);
        });
    });

    sidebarSearchInput.addEventListener('input', debounce(function() {
        var q = sidebarSearchInput.value.trim();
        sidebarSearchClear.classList.toggle('hidden', q.length === 0);
        if (q.length < 2) {
            hideSearchResultsPanel();
            return;
        }
        performSidebarSearch(q);
    }, 350));

    sidebarSearchInput.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            sidebarSearchInput.value = '';
            sidebarSearchClear.classList.add('hidden');
            hideSearchResultsPanel();
        }
    });

    sidebarSearchClear.addEventListener('click', function() {
        sidebarSearchInput.value = '';
        sidebarSearchClear.classList.add('hidden');
        hideSearchResultsPanel();
        sidebarSearchInput.focus();
    });
}

// Toggles between the two search modes (see the `searchMode` state comment
// at the top of this file). One click on بحث reveals the scope options and
// switches to scoped page-content search; another click hides them again
// and reverts to the title/heading quick-jump index.
function toggleContentSearchMode() {
    searchMode = (searchMode === 'nav') ? 'content' : 'nav';

    var contentModeOn = (searchMode === 'content');
    sidebarSearchScope.classList.toggle('hidden', !contentModeOn);
    btnSearchToggle.classList.toggle('active-toggle', contentModeOn);
    sidebarSearchInput.placeholder = contentModeOn
        ? 'بحث في نصوص الصفحات...'
        : 'بحث في عناوين الكتب والفهارس...';

    sidebarSearchInput.focus();

    var q = sidebarSearchInput.value.trim();
    if (q.length >= 2) {
        performSidebarSearch(q);
    } else {
        hideSearchResultsPanel();
    }
}

function showSearchResultsPanel() {
    sidebarSearchResults.classList.remove('hidden');
    bookTree.classList.add('hidden');
}

function hideSearchResultsPanel() {
    sidebarSearchResults.classList.add('hidden');
    bookTree.classList.remove('hidden');
}

function performSidebarSearch(query) {
    sidebarSearchResults.innerHTML = '<div class="loading-msg" style="padding:16px">جارٍ البحث...</div>';
    showSearchResultsPanel();

    fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: query, book_id: currentBookId, scope: searchScope, mode: searchMode })
    })
    .then(function(res) {
        if (!res.ok) throw new Error('Search failed: ' + res.status);
        return res.json();
    })
    .then(function(data) {
        // Bail out if the input has since changed (a newer debounced
        // search will render its own results) to avoid flicker.
        if (sidebarSearchInput.value.trim() !== query) return;
        renderSidebarSearchResults(data, query);
    })
    .catch(function(err) {
        console.error('Search error:', err);
        sidebarSearchResults.innerHTML = '<div class="error-msg" style="padding:12px">خطأ في البحث: ' + escapeHtml(err.message) + '</div>';
    });
}

function renderSidebarSearchResults(data, query) {
    var results = (data && data.results) || [];
    var words = (data && data.match_words) || [];

    var html = '<div class="search-results-summary"><span>' +
        (results.length ? (results.length + ' نتيجة لـ «' + escapeHtml(query) + '»') : ('لا توجد نتائج لـ «' + escapeHtml(query) + '»')) +
        '</span><button class="search-back-btn" id="search-back-to-tree" type="button">← فهرس الكتب</button></div>';

    results.forEach(function(r, idx) {
        if (r.type === 'book') {
            html += '<div class="search-result-item book-result" data-idx="' + idx + '" data-result-type="book" data-book-id="' + r.book_id + '">' +
                '<div class="result-title">📖 ' + escapeHtml(r.book_title) + '</div>' +
                '<div class="result-meta">فتح الكتاب</div></div>';
        } else {
            var metaLine = r.is_heading_match
                ? ('📑 ' + (r.heading ? escapeHtml(r.heading) : 'عنوان'))
                : ('صفحة ' + r.slide_number);
            html += '<div class="search-result-item" data-idx="' + idx + '" data-result-type="slide" data-book-id="' + r.book_id +
                '" data-slide-number="' + r.slide_number + '">' +
                '<div class="result-title">' + escapeHtml(r.book_title) + '</div>' +
                '<div class="result-meta">' + metaLine + '</div>' +
                '<div class="result-snippet">' + r.snippet_html + '</div></div>';
        }
    });

    sidebarSearchResults.innerHTML = html;

    var backBtn = document.getElementById('search-back-to-tree');
    if (backBtn) {
        backBtn.addEventListener('click', function() {
            sidebarSearchInput.value = '';
            sidebarSearchClear.classList.add('hidden');
            hideSearchResultsPanel();
        });
    }

    sidebarSearchResults.querySelectorAll('.search-result-item').forEach(function(item) {
        item.addEventListener('click', function() {
            var bookId = parseInt(item.dataset.bookId, 10);
            if (item.dataset.resultType === 'book') {
                openBookById(bookId, null);
            } else {
                var slideNumber = parseInt(item.dataset.slideNumber, 10);
                openBookById(bookId, { type: 'slide', value: slideNumber, words: words });
            }
            // The results panel is deliberately left exactly as-is here —
            // not cleared or hidden — so the user can come back and open a
            // different result afterwards without searching again.
        });
    });
}

// ── Instant TOC Filter ──
// A lightweight, purely client-side complement to the server-side search
// above: it filters whichever .tree-node/.tree-heading elements are
// *already rendered in the DOM* right now via simple show/hide, with no
// network call at all. Because headings are only rendered once a book is
// expanded, this can only filter within books you've already opened —
// that's the deliberate, simpler scope asked for here (as opposed to the
// server-side search box, which finds matches anywhere in the library
// regardless of what's currently expanded).
function setupTOCSearch() {
    if (!tocSearchInput || !tocSearchClear) return;

    var tocSearchTimeout;

    tocSearchInput.addEventListener('input', function() {
        clearTimeout(tocSearchTimeout);
        tocSearchTimeout = setTimeout(filterTOCBySearch, 300);
        tocSearchClear.classList.toggle('hidden', tocSearchInput.value === '');
    });

    tocSearchClear.addEventListener('click', function() {
        tocSearchInput.value = '';
        filterTOCBySearch();
        tocSearchClear.classList.add('hidden');
        tocSearchInput.focus();
    });

    tocSearchInput.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            tocSearchInput.value = '';
            filterTOCBySearch();
            tocSearchClear.classList.add('hidden');
        }
    });
}

function filterTOCBySearch() {
    var query = tocSearchInput.value.trim().toLowerCase();
    if (!query) {
        var allNodes = bookTree.querySelectorAll('.tree-node, .tree-heading');
        allNodes.forEach(function(node) {
            node.style.display = '';
        });
        return;
    }

    var hasMatches = false;
    var allNodes = bookTree.querySelectorAll('.tree-node, .tree-heading');

    allNodes.forEach(function(node) {
        var text = node.textContent.toLowerCase();
        if (text.includes(query)) {
            node.style.display = '';
            var parentNode = node.closest('.tree-node');
            if (parentNode) {
                parentNode.style.display = '';
                var children = parentNode.querySelector('.tree-children');
                if (children) {
                    children.classList.add('open');
                    var toggle = parentNode.querySelector('.tree-arrow');
                    if (toggle) toggle.classList.add('expanded');
                }
            }
            hasMatches = true;
        } else {
            node.style.display = 'none';
        }
    });

    if (!hasMatches) {
        allNodes.forEach(function(node) {
            node.style.display = '';
        });
    }
}

// ── AI Chat ──
function toggleAI(show) {
    aiPanel.classList.toggle('hidden', !show);
}

function sendAIQuestion() {
    var question = aiInput.value.trim();
    if (!question) return;

    addAIMessage(question, 'user');
    aiInput.value = '';

    var btn = document.getElementById('btn-send-ai');
    btn.textContent = 'جارٍ التفكير...';
    btn.disabled = true;

    fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: question, agent: aiAgentSelect ? aiAgentSelect.value : 'gemini' })
    })
    .then(function(res) { return res.json(); })
    .then(function(data) {
        addAIMessage(data.answer, 'bot', data.sources);
    })
    .catch(function(err) {
        addAIMessage('حدث خطأ في الاتصال بالمساعد الذكي.', 'bot');
    })
    .finally(function() {
        btn.textContent = 'إرسال';
        btn.disabled = false;
    });
}

function addAIMessage(text, type, sources) {
    sources = sources || [];
    var msg = document.createElement('div');
    msg.className = 'ai-message ' + type;

    var html = escapeHtml(text).replace(/\n/g, '<br>');

    if (sources.length > 0 && type === 'bot') {
        html += '<div style="margin-top:10px;border-top:1px dashed #d4c9b8;padding-top:8px;font-size:0.85rem;color:#8b6914">المصادر:</div>';
        sources.forEach(function(src, idx) {
            var clean = src.split('\n')[0].replace('[المصدر:', '').replace(']', '').trim();
            html += '<div class="source-citation" data-source="' + escapeHtml(src) + '">' + (idx + 1) + '. ' + escapeHtml(clean) + '</div>';
        });
    }

    msg.innerHTML = html;
    aiMessages.appendChild(msg);
    aiMessages.scrollTop = aiMessages.scrollHeight;
}

// ── Utilities ──
function debounce(fn, delay) {
    var timer;
    return function() {
        var args = arguments;
        clearTimeout(timer);
        timer = setTimeout(function() { fn.apply(null, args); }, delay);
    };
}

function escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
