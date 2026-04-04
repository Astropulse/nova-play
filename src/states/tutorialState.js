import { TUTORIAL_CATEGORIES } from '../data/tutorials.js';
import { TUTORIAL_DESCRIPTIONS } from '../data/tutorialDescriptions.js';
import { MenuState } from './menuState.js';

const TAG_COLORS = {
    scrap:   '#ffff44',
    upgrade: '#44ddff',
    cost:    '#ff4444',
    good:    '#44ff44',
    warn:    '#ff8844'
};

export class TutorialState {
    constructor(game) {
        this.game = game;

        // View: 'BROWSE' (sidebar + empty), 'PLAYBACK' (sidebar + video)
        this.view = 'BROWSE';

        // Category state
        this.expandedCategoryIdx = 0; // Default to first category
        this.selectedCategoryIdx = 0;
        this.selectedVideoIdx = 0;

        // Animation state for categories (0..1 multiplier for height)
        this.catMultipliers = TUTORIAL_CATEGORIES.map((_, i) => i === 0 ? 1 : 0);

        // Video playback
        this.videoElement = null;
        this.videoLoaded = false;

        // Transition animation
        this.fadeIn = 0; // 0..1 for video fade

        // UI buttons
        this.homeBtn = { x: 0, y: 0, w: 0, h: 0, hovered: false, key: 'home_button' };
        this.leftBtn = { x: 0, y: 0, w: 0, h: 0, hovered: false, key: 'left_arrow' };
        this.rightBtn = { x: 0, y: 0, w: 0, h: 0, hovered: false, key: 'right_arrow' };

        // Sidebar hit areas (rebuilt each frame)
        this.sidebarItems = []; // { x, y, w, h, type: 'category'|'video', catIdx, vidIdx? }
        this._lastMouse = { x: 0, y: 0 };

        // Sidebar scroll state for long titles
        this._hoveredVidKey = null;  // 'catIdx_vidIdx' of currently hovered item
        this._hoverTime = 0;         // how long we've been hovering

        this.time = 0;
    }

    enter() {
        // Start exploration music
        this.game.sounds.startMusic();
        this.game.sounds.unlock();

        // Default open the first tutorial
        this.view = 'PLAYBACK';
        this._startVideo(0, 0);
    }

    exit() {
        this._stopVideo();
    }

    _stopVideo() {
        if (this.videoElement) {
            this.videoElement.pause();
            this.videoElement.src = '';
            this.videoElement.load();
            this.videoElement = null;
        }
        this.videoLoaded = false;
        this.fadeIn = 0;
    }

    _startVideo(catIdx, vidIdx) {
        this._stopVideo();
        const cat = TUTORIAL_CATEGORIES[catIdx];
        const videoName = cat.videos[vidIdx];
        const path = `Assets/Tutorials/${cat.id}/${videoName}.webm`;

        this.selectedCategoryIdx = catIdx;
        this.selectedVideoIdx = vidIdx;
        this.expandedCategoryIdx = catIdx;
        this.view = 'PLAYBACK';

        this.videoElement = document.createElement('video');
        this.videoElement.src = path;
        this.videoElement.loop = true;
        this.videoElement.muted = false;
        this.videoElement.onloadeddata = () => {
            this.videoLoaded = true;
            this.videoElement.play().catch(e => console.warn('Video play blocked:', e));
        };
        this.videoElement.load();
    }

    _navigateVideo(dir) {
        const cat = TUTORIAL_CATEGORIES[this.selectedCategoryIdx];
        const newIdx = (this.selectedVideoIdx + dir + cat.videos.length) % cat.videos.length;
        this._startVideo(this.selectedCategoryIdx, newIdx);
    }

    update(dt) {
        this.time += dt;

        // Animate category expansion/collapse
        for (let i = 0; i < this.catMultipliers.length; i++) {
            const target = (this.expandedCategoryIdx === i) ? 1 : 0;
            const diff = target - this.catMultipliers[i];
            // Fast animation ~0.15s
            this.catMultipliers[i] += diff * Math.min(1, dt * 15);
        }

        // Fade in animation
        if (this.view === 'PLAYBACK' && this.videoLoaded && this.fadeIn < 1) {
            this.fadeIn = Math.min(1, this.fadeIn + dt * 3);
        }

        const mouse = this.game.getMousePos();
        this._lastMouse = mouse;

        // Hover updates
        this.homeBtn.hovered = this._isInside(mouse, this.homeBtn);
        this.leftBtn.hovered = this.view === 'PLAYBACK' && this._isInside(mouse, this.leftBtn);
        this.rightBtn.hovered = this.view === 'PLAYBACK' && this._isInside(mouse, this.rightBtn);

        // Sidebar hover
        for (const item of this.sidebarItems) {
            item.hovered = this._isInside(mouse, item);
        }

        // Volume sync
        if (this.videoElement && this.videoLoaded) {
            this.videoElement.volume = this.game.sounds.sfxVolume;
        }

        // Click handling
        if (this.game.input.isMouseJustPressed(0)) {
            // Home button
            if (this.homeBtn.hovered) {
                this.game.sounds.play('click', 1.0);
                this.game.setState(new MenuState(this.game));
                return;
            }

            // Arrow navigation
            if (this.view === 'PLAYBACK') {
                if (this.leftBtn.hovered) {
                    this.game.sounds.play('click', 1.0);
                    this._navigateVideo(-1);
                    return;
                }
                if (this.rightBtn.hovered) {
                    this.game.sounds.play('click', 1.0);
                    this._navigateVideo(1);
                    return;
                }
            }

            // Sidebar clicks
            for (const item of this.sidebarItems) {
                if (!item.hovered) continue;

                if (item.type === 'category') {
                    this.game.sounds.play('click', 1.0);
                    if (this.expandedCategoryIdx === item.catIdx) {
                        // Collapse
                        this.expandedCategoryIdx = -1;
                    } else {
                        // Expand
                        this.expandedCategoryIdx = item.catIdx;
                    }
                    break;
                }

                if (item.type === 'video') {
                    this.game.sounds.play('select', 1.0);
                    this._startVideo(item.catIdx, item.vidIdx);
                    break;
                }
            }
        }

        // Escape key
        if (this.game.input.isKeyJustPressed('Escape')) {
            if (this.view === 'PLAYBACK') {
                this.game.sounds.play('click', 1.0);
                this._stopVideo();
                this.view = 'BROWSE';
                this.selectedCategoryIdx = -1;
                this.selectedVideoIdx = -1;
            } else {
                this.game.setState(new MenuState(this.game));
            }
        }

        // Arrow keys for video navigation
        if (this.view === 'PLAYBACK') {
            if (this.game.input.isKeyJustPressed('ArrowLeft')) {
                this.game.sounds.play('click', 1.0);
                this._navigateVideo(-1);
            }
            if (this.game.input.isKeyJustPressed('ArrowRight')) {
                this.game.sounds.play('click', 1.0);
                this._navigateVideo(1);
            }
        }
    }

    draw(ctx) {
        const game = this.game;
        const cw = game.width;
        const ch = game.height;
        const uiScale = game.uiScale;
        const margin = Math.floor(uiScale * 8);

        ctx.save();

        // Background
        ctx.fillStyle = '#050a14';
        ctx.fillRect(0, 0, cw, ch);

        // --- Sidebar ---
        const sidebarW = Math.floor(Math.min(cw * 0.3, uiScale * 110));
        this._drawSidebar(ctx, sidebarW, ch, uiScale, margin);

        // --- Home button (bottom-left of sidebar) ---
        const homeSize = game.spriteSize('home_button_off', uiScale);
        this.homeBtn.x = Math.floor(sidebarW / 2 - homeSize.w / 2);
        this.homeBtn.y = ch - margin - homeSize.h;
        this.homeBtn.w = homeSize.w;
        this.homeBtn.h = homeSize.h;
        this._drawSpriteButton(ctx, this.homeBtn);

        // --- Main Content Area ---
        const contentX = sidebarW;
        const contentW = cw - sidebarW;
        const contentCx = contentX + contentW / 2;

        if (this.view === 'PLAYBACK') {
            this._drawPlayback(ctx, contentX, contentW, contentCx, ch, uiScale, margin);
        } else {
            // Browse mode — show a hint in the content area
            ctx.fillStyle = '#334455';
            ctx.font = `${Math.floor(8 * uiScale)}px Astro4x`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('SELECT A TUTORIAL', contentCx, ch / 2);
            ctx.textBaseline = 'alphabetic';
        }

        ctx.restore();
    }

    _drawSidebar(ctx, sidebarW, ch, uiScale, margin) {
        // Sidebar background
        ctx.fillStyle = '#0a1220';
        ctx.fillRect(0, 0, sidebarW, ch);

        // Right edge line
        ctx.strokeStyle = '#1a2a3a';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(sidebarW - 0.5, 0);
        ctx.lineTo(sidebarW - 0.5, ch);
        ctx.stroke();

        // Header
        const headerH = Math.floor(uiScale * 24);
        ctx.fillStyle = '#44ddff';
        ctx.font = `${Math.floor(9 * uiScale)}px Astro5x`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('TUTORIALS', sidebarW / 2, headerH / 2 + margin);
        ctx.textBaseline = 'alphabetic';

        // Divider under header
        const divY = headerH + margin;
        ctx.strokeStyle = '#1a3a5a';
        ctx.beginPath();
        ctx.moveTo(margin, divY);
        ctx.lineTo(sidebarW - margin, divY);
        ctx.stroke();

        // Build sidebar items
        this.sidebarItems = [];
        const mouse = this._lastMouse;
        const catFontSize = Math.floor(7 * uiScale);
        const vidFontSize = Math.floor(6 * uiScale);
        const catH = Math.floor(uiScale * 20);
        const vidH = Math.floor(uiScale * 16);
        const gap = Math.floor(uiScale * 2);
        let y = divY + Math.floor(uiScale * 6);

        for (let ci = 0; ci < TUTORIAL_CATEGORIES.length; ci++) {
            const cat = TUTORIAL_CATEGORIES[ci];
            const isExpanded = this.expandedCategoryIdx === ci;
            const isActiveCat = this.selectedCategoryIdx === ci;

            // Category header
            const catItem = {
                x: margin, y: y, w: sidebarW - margin * 2, h: catH,
                type: 'category', catIdx: ci, hovered: false
            };
            catItem.hovered = this._isInside(mouse, catItem);
            this.sidebarItems.push(catItem);

            // Draw category
            const catHovered = catItem.hovered;
            const catActive = isExpanded || isActiveCat;

            // Background highlight
            if (catHovered || catActive) {
                ctx.fillStyle = catHovered ? 'rgba(68, 221, 255, 0.08)' : 'rgba(68, 221, 255, 0.04)';
                ctx.fillRect(catItem.x, catItem.y, catItem.w, catItem.h);
            }

            // Category text
            ctx.font = `${catFontSize}px Astro5x`;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';

            // Expand indicator
            const indicator = isExpanded ? '▼' : '►';
            ctx.fillStyle = catActive ? '#44ddff' : '#556677';
            ctx.fillText(indicator, catItem.x + Math.floor(uiScale * 3), catItem.y + catItem.h / 2);

            ctx.fillStyle = catHovered ? '#ffffff' :
                (catActive ? '#44ddff' : '#8899aa');
            ctx.fillText(cat.name, catItem.x + Math.floor(uiScale * 12), catItem.y + catItem.h / 2);

            // Video count badge
            ctx.font = `${Math.floor(5 * uiScale)}px Astro4x`;
            ctx.fillStyle = '#445566';
            ctx.textAlign = 'right';
            ctx.fillText(`${cat.videos.length}`, catItem.x + catItem.w - Math.floor(uiScale * 2), catItem.y + catItem.h / 2);

            y += catH + gap;

            const multiplier = this.catMultipliers[ci];

            // Expanded videos (animated height)
            if (multiplier > 0.001) {
                const totalExpandedHeight = ((vidH + gap) * cat.videos.length) + Math.floor(uiScale * 4);
                const currentHeight = totalExpandedHeight * multiplier;

                // Create a clipping region for the smooth dropdown animation
                ctx.save();
                ctx.beginPath();
                ctx.rect(0, y, sidebarW, currentHeight);
                ctx.clip();
                
                // Track where drawing *would* happen if fully expanded
                let drawY = y - (totalExpandedHeight * (1 - multiplier));

                for (let vi = 0; vi < cat.videos.length; vi++) {
                    const isSelected = isActiveCat && this.selectedVideoIdx === vi;

                    const vidItem = {
                        x: margin + Math.floor(uiScale * 8), y: drawY,
                        w: sidebarW - margin * 2 - Math.floor(uiScale * 8), h: vidH,
                        type: 'video', catIdx: ci, vidIdx: vi, hovered: false
                    };
                    vidItem.hovered = this._isInside(mouse, vidItem);
                    this.sidebarItems.push(vidItem);

                    const vidHovered = vidItem.hovered;

                    // Selection/hover bg
                    if (isSelected) {
                        ctx.fillStyle = 'rgba(68, 221, 255, 0.15)';
                        ctx.fillRect(vidItem.x, vidItem.y, vidItem.w, vidItem.h);
                        // Left accent bar
                        ctx.fillStyle = '#44ddff';
                        ctx.fillRect(vidItem.x, vidItem.y + 2, Math.floor(uiScale * 1.5), vidItem.h - 4);
                    } else if (vidHovered) {
                        ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
                        ctx.fillRect(vidItem.x, vidItem.y, vidItem.w, vidItem.h);
                    }

                    // Video title — clipped to sidebar, scrolls on hover
                    ctx.save();
                    ctx.beginPath();
                    ctx.rect(vidItem.x, vidItem.y, vidItem.w, vidItem.h);
                    ctx.clip();

                    ctx.font = `${vidFontSize}px Astro4x`;
                    ctx.textAlign = 'left';
                    ctx.textBaseline = 'middle';
                    const title = this._getCleanTitle(cat.videos[vi]);
                    ctx.fillStyle = isSelected ? '#ffffff' :
                        (vidHovered ? '#ccddee' : '#778899');

                    const textPad = Math.floor(uiScale * 5);
                    const titleW = ctx.measureText(title).width;
                    const availW = vidItem.w - textPad * 2;
                    let textX = vidItem.x + textPad;

                    // Scroll long titles on hover
                    const vidKey = `${ci}_${vi}`;
                    if (vidHovered && titleW > availW) {
                        if (this._hoveredVidKey !== vidKey) {
                            this._hoveredVidKey = vidKey;
                            this._hoverTime = 0;
                        }
                        this._hoverTime += 0.016; // ~1 frame at 60fps
                        const scrollDelay = 0.5; // seconds before scrolling starts
                        if (this._hoverTime > scrollDelay) {
                            const scrollSpeed = uiScale * 20; // px/sec
                            const maxScroll = titleW - availW;
                            const elapsed = this._hoverTime - scrollDelay;
                            // Ping-pong scroll
                            const cycle = (maxScroll * 2) / scrollSpeed;
                            const t = (elapsed % cycle) / cycle;
                            const offset = t < 0.5 ? t * 2 * maxScroll : (1 - (t - 0.5) * 2) * maxScroll;
                            textX -= offset;
                        }
                    } else if (this._hoveredVidKey === vidKey && !vidHovered) {
                        this._hoveredVidKey = null;
                        this._hoverTime = 0;
                    }

                    ctx.fillText(title, textX, vidItem.y + vidItem.h / 2);

                    ctx.restore();

                    drawY += vidH + gap;
                }

                ctx.restore(); // Remove clipping

                // Advance the actual layout Y by the animated height
                y += currentHeight;
            }
        }

        ctx.textBaseline = 'alphabetic';
    }

    _drawPlayback(ctx, contentX, contentW, contentCx, ch, uiScale, margin) {
        const game = this.game;

        // Video area sizing — leave room at bottom for description
        const videoMaxW = contentW * 0.9;
        const videoMaxH = ch * 0.58;
        const topOffset = Math.floor(uiScale * 20);

        // Title above video
        const cat = TUTORIAL_CATEGORIES[this.selectedCategoryIdx];
        const videoName = cat.videos[this.selectedVideoIdx];
        const title = this._getCleanTitle(videoName).toUpperCase();

        ctx.font = `${Math.floor(9 * uiScale)}px Astro5x`;
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.fillText(title, contentCx, topOffset);

        // Category breadcrumb
        ctx.font = `${Math.floor(5 * uiScale)}px Astro4x`;
        ctx.fillStyle = '#44ddff';
        ctx.fillText(`${cat.name}  ·  ${this.selectedVideoIdx + 1} / ${cat.videos.length}`, contentCx, topOffset + Math.floor(uiScale * 9));

        if (this.videoElement && this.videoLoaded) {
            const vW = this.videoElement.videoWidth;
            const vH = this.videoElement.videoHeight;
            const ratio = vW / vH;

            let renderW = videoMaxW;
            let renderH = renderW / ratio;
            if (renderH > videoMaxH) {
                renderH = videoMaxH;
                renderW = renderH * ratio;
            }

            const rx = Math.floor(contentCx - renderW / 2);
            const ry = topOffset + Math.floor(uiScale * 14);

            // Fade in
            const alpha = this.fadeIn;

            // Video shadow/glow
            if (alpha > 0.5) {
                ctx.shadowColor = 'rgba(68, 221, 255, 0.15)';
                ctx.shadowBlur = 20;
            }

            ctx.globalAlpha = alpha;

            // Draw video frame
            ctx.drawImage(this.videoElement, rx, ry, renderW, renderH);

            ctx.shadowColor = 'transparent';
            ctx.shadowBlur = 0;

            // Border
            ctx.strokeStyle = `rgba(34, 51, 68, ${alpha})`;
            ctx.lineWidth = Math.max(1, Math.floor(uiScale * 0.5));
            ctx.strokeRect(rx - 1, ry - 1, renderW + 2, renderH + 2);

            // Corner accents
            const cornerLen = Math.floor(uiScale * 6);
            ctx.strokeStyle = `rgba(68, 221, 255, ${alpha * 0.6})`;
            ctx.lineWidth = Math.max(1, Math.floor(uiScale));
            // Top-left
            ctx.beginPath();
            ctx.moveTo(rx - 1, ry - 1 + cornerLen);
            ctx.lineTo(rx - 1, ry - 1);
            ctx.lineTo(rx - 1 + cornerLen, ry - 1);
            ctx.stroke();
            // Top-right
            ctx.beginPath();
            ctx.moveTo(rx + renderW + 1 - cornerLen, ry - 1);
            ctx.lineTo(rx + renderW + 1, ry - 1);
            ctx.lineTo(rx + renderW + 1, ry - 1 + cornerLen);
            ctx.stroke();
            // Bottom-left
            ctx.beginPath();
            ctx.moveTo(rx - 1, ry + renderH + 1 - cornerLen);
            ctx.lineTo(rx - 1, ry + renderH + 1);
            ctx.lineTo(rx - 1 + cornerLen, ry + renderH + 1);
            ctx.stroke();
            // Bottom-right
            ctx.beginPath();
            ctx.moveTo(rx + renderW + 1 - cornerLen, ry + renderH + 1);
            ctx.lineTo(rx + renderW + 1, ry + renderH + 1);
            ctx.lineTo(rx + renderW + 1, ry + renderH + 1 - cornerLen);
            ctx.stroke();

            ctx.globalAlpha = 1;

            // --- Arrow buttons ---
            const arrowSize = game.spriteSize('left_arrow_off', uiScale);
            const arrowY = ry + renderH / 2 - arrowSize.h / 2;

            this.leftBtn.x = rx - arrowSize.w - margin * 2;
            this.leftBtn.y = arrowY;
            this.leftBtn.w = arrowSize.w;
            this.leftBtn.h = arrowSize.h;

            this.rightBtn.x = rx + renderW + margin * 2;
            this.rightBtn.y = arrowY;
            this.rightBtn.w = arrowSize.w;
            this.rightBtn.h = arrowSize.h;

            this._drawSpriteButton(ctx, this.leftBtn);
            this._drawSpriteButton(ctx, this.rightBtn);

            // --- Description text ---
            const descY = ry + renderH + Math.floor(uiScale * 12);
            const descMaxW = renderW * 0.66;
            this._drawDescription(ctx, contentCx, descY, descMaxW, uiScale, ch);

        } else {
            // Loading state
            ctx.fillStyle = '#334455';
            ctx.font = `${Math.floor(7 * uiScale)}px Astro4x`;
            ctx.textAlign = 'center';
            const loadY = topOffset + Math.floor(uiScale * 60);
            const dots = '.'.repeat(Math.floor(this.time * 3) % 4);
            ctx.fillText('LOADING' + dots, contentCx, loadY);
        }
    }

    _drawDescription(ctx, cx, startY, maxW, uiScale, ch) {
        const cat = TUTORIAL_CATEGORIES[this.selectedCategoryIdx];
        const videoName = cat.videos[this.selectedVideoIdx];
        const cleanTitle = this._getCleanTitle(videoName);
        const sections = (TUTORIAL_DESCRIPTIONS[cat.id] && TUTORIAL_DESCRIPTIONS[cat.id][cleanTitle]) || ['No description available.'];

        const fontSize = Math.floor(7 * uiScale);
        const lineH = Math.floor(fontSize * 1.7);
        const paragraphGap = Math.floor(uiScale * 4);

        ctx.font = `${fontSize}px Astro5x`;
        ctx.textAlign = 'left';

        let y = startY;

        for (const sectionText of sections) {
            const segments = this._parse(sectionText);
            const lines = this._wrapSegments(ctx, segments, maxW);

            for (const line of lines) {
                if (y > ch - Math.floor(uiScale * 6)) break; // Don't draw off-screen

                // Center the line
                const lineW = line.reduce((sum, seg) => sum + ctx.measureText(seg.text).width, 0);
                let x = cx - lineW / 2;

                for (const seg of line) {
                    ctx.fillStyle = seg.color;
                    ctx.fillText(seg.text, x, y);
                    x += ctx.measureText(seg.text).width;
                }
                y += lineH;
            }
            y += paragraphGap;
        }
    }

    _drawSpriteButton(ctx, btn) {
        const key = `${btn.key}_${btn.hovered ? 'on' : 'off'}`;
        this.game.drawSprite(ctx, key, btn.x, btn.y, this.game.uiScale);
    }

    _getCleanTitle(filename) {
        return filename.split('_').slice(1).join(' ');
    }

    // --- Rich Text ---

    _parse(text) {
        const segments = [];
        let pos = 0;
        const regex = /\[(\w+)\](.*?)\[\/\1\]/g;
        let match;
        while ((match = regex.exec(text)) !== null) {
            if (match.index > pos) {
                segments.push({ text: text.slice(pos, match.index), color: '#ccddee' });
            }
            segments.push({
                text: match[2],
                color: TAG_COLORS[match[1]] || '#ccddee'
            });
            pos = match.index + match[0].length;
        }
        if (pos < text.length) {
            segments.push({ text: text.slice(pos), color: '#ccddee' });
        }
        return segments;
    }

    _wrapSegments(ctx, segments, maxWidth) {
        // Flatten segments into individual words, each carrying its color
        const words = [];
        for (const seg of segments) {
            // Trim to avoid phantom empty words from spaces around color tags
            const trimmed = seg.text.trim();
            if (trimmed.length === 0) continue;
            const parts = trimmed.split(/\s+/);
            for (let i = 0; i < parts.length; i++) {
                if (parts[i].length === 0) continue;
                words.push({ text: parts[i], color: seg.color });
            }
        }

        // Now lay out words into lines
        const spaceW = ctx.measureText(' ').width;
        const lines = [];
        let currentLine = [];
        let currentW = 0;

        for (let i = 0; i < words.length; i++) {
            const word = words[i];
            const wordW = ctx.measureText(word.text).width;
            const needed = currentLine.length > 0 ? spaceW + wordW : wordW;

            if (currentW + needed > maxWidth && currentLine.length > 0) {
                lines.push(this._finalizeLine(currentLine, spaceW));
                currentLine = [];
                currentW = 0;
            }

            currentLine.push(word);
            currentW += (currentLine.length > 1 ? spaceW + wordW : wordW);
        }

        if (currentLine.length > 0) {
            lines.push(this._finalizeLine(currentLine, spaceW));
        }

        return lines;
    }

    _finalizeLine(words, spaceW) {
        // Convert word objects into drawable segments, inserting spaces
        const segments = [];
        for (let i = 0; i < words.length; i++) {
            if (i > 0) {
                // Insert a space with the color of the next word
                segments.push({ text: ' ', color: words[i].color });
            }
            segments.push({ text: words[i].text, color: words[i].color });
        }
        return segments;
    }

    _isInside(point, rect) {
        return point.x >= rect.x && point.x <= rect.x + rect.w &&
            point.y >= rect.y && point.y <= rect.y + rect.h;
    }
}
