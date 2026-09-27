/**
 * Domain Expansion Detection and VFX System
 * Logic strictly following JJK project hierarchical model.
 */

// MediaPipe Hand Landmark Constants
const W_ = 0, TH_MCP = 2, TH_TIP = 4, I_MCP = 5, I_PIP = 6, I_TIP = 8;
const M_MCP = 9, M_PIP = 10, M_TIP = 12, R_MCP = 13, R_PIP = 14, R_TIP = 16, P_MCP = 17, P_PIP = 18, P_TIP = 20;

class DomainExpansionGame {
    constructor() {
        this.predictionHistory = [];
        this.historyMaxLen = 10;
        this.stableDomain = null;

        this.vfxCanvas = null;
        this.vfxCtx = null;

        this.lang = 'zh'; // Default to ZH
        this.displayNamesMap = {
            'en': {
                "Unlimited Void": "Gojo Satoru: Unlimited Void",
                "Malevolent Shrine": "Ryomen Sukuna: Malevolent Shrine",
                "Self-Embodiment of Perfection": "Mahito: Self-Embodiment",
                "Authentic Mutual Love": "Yuta Okkotsu: Authentic Love",
                "Idle Death Gamble": "Kinji Hakari: Idle Death Gamble",
                "Yuji Itadori": "Yuji Itadori: Unnamed Domain",
                "Chimera Shadow Garden": "Megumi Fushiguro: Chimera Garden",
                "Time Cell Moon Palace": "Naoya Zenin: Time Cell Moon",
                "Lapse Blue": "Gojo Satoru: Lapse Blue",
                "Reversal Red": "Gojo Satoru: Reversal Red",
                "Hollow Purple": "Gojo Satoru: Hollow Purple"
            },
            'ja': {
                "Unlimited Void": "五条悟: 無量空処",
                "Malevolent Shrine": "両面宿儺: 伏魔御厨子",
                "Self-Embodiment of Perfection": "真人: 自閉円頓裹",
                "Authentic Mutual Love": "乙骨憂太: 真贋相愛",
                "Idle Death Gamble": "秤金次: 坐殺博徒",
                "Yuji Itadori": "虎杖悠仁: 名称不明",
                "Chimera Shadow Garden": "伏黒恵: 嵌合暗翳庭園",
                "Time Cell Moon Palace": "禪院直哉: 時胞月宮殿",
                "Lapse Blue": "五条悟: 「蒼」",
                "Reversal Red": "五条悟: 「赫」",
                "Hollow Purple": "五条悟: 「茈」"
            },
            'zh': {
                "Unlimited Void": "五條悟: 無量空處",
                "Malevolent Shrine": "兩面宿儺: 伏魔御廚子",
                "Self-Embodiment of Perfection": "真人: 自閉圓頓裹",
                "Authentic Mutual Love": "乙骨憂太: 真贋相愛",
                "Idle Death Gamble": "秤金次: 坐殺博徒",
                "Yuji Itadori": "虎杖悠仁: 名稱不明",
                "Chimera Shadow Garden": "伏黑惠: 嵌合暗翳庭園",
                "Time Cell Moon Palace": "禪院直哉: 時胞月宮殿",
                "Lapse Blue": "五條悟: 「蒼」",
                "Reversal Red": "五條悟: 「赫」",
                "Hollow Purple": "五條悟: 「茈」"
            }
        };
        this.displayNames = this.displayNamesMap['zh'];

        this.domainColors = {
            "Unlimited Void": "#FFFFFF",
            "Malevolent Shrine": "#FF0000",
            "Self-Embodiment of Perfection": "#AA00FF",
            "Authentic Mutual Love": "#EE82EE",
            "Idle Death Gamble": "#FFD700",
            "Yuji Itadori": "#00FF00",
            "Chimera Shadow Garden": "#191970",
            "Time Cell Moon Palace": "#FF69B4",
            "Lapse Blue": "#0000FF",
            "Reversal Red": "#FF4500",
            "Hollow Purple": "#9400D3"
        };

        // VFX State
        this.stars = [];
        this.symbols = [];
        this.slashes = [];
        this.flashCounter = 0;
        this.mahitoPhase = 0;
        this.yutaPhase = 0;
        this.hakariPhase = 0;
        this.slotNumbers = ["7", "7", "7"];
        this.confetti = [];
        this.yujiPhase = 0;
        this.shockwaveRad = 0;
        
        this.blueOrbRad = 0;
        this.redOrbRad = 0;
        this.purpleBeamProgress = 0;

        // Load Rika Image for Yuta
        this.rikaImg = new Image();
        this.rikaImg.src = 'static/img/rika.png';

        // Load Shrine Image for Sukuna
        this.shrineImg = new Image();
        this.shrineImg.src = 'static/img/malevolent-shrine.png';

        // Load Mahito Image
        this.mahitoImg = new Image();
        this.mahitoImg.src = 'static/img/self-embodiment.png';

        // Load Hakari Image
        this.hakariImg = new Image();
        this.hakariImg.src = 'static/img/idle-death-gamble.png';

        // Load Chimera Garden Image
        this.chimeraImg = new Image();
        this.chimeraImg.src = 'static/img/chimera-garden.png';

        this.chimeraPhase = 0;

        // Load Naoya Image
        this.naoyaImg = new Image();
        this.naoyaImg.src = 'static/img/time-cell-palace.png';

        // Load Unlimited Void Image
        this.voidImg = new Image();
        this.voidImg.src = 'static/img/unlimited-void.png';

        this.voidPhase = 0;
    }

    initVFX(canvas) {
        this.vfxCanvas = canvas;
        this.vfxCtx = canvas.getContext('2d');
        this.initStars(canvas.width, canvas.height);
    }

    setLanguage(lang) {
        if (this.displayNamesMap[lang]) {
            this.lang = lang;
            this.displayNames = this.displayNamesMap[lang];
        }
    }

    // --- MediaPipe Helper Functions (JJK Reference) ---

    fingerState(lm, mcp, pip, tip) {
        const distMCP_PIP = this.d2(lm[mcp], lm[pip]);
        const distMCP_TIP = this.d2(lm[mcp], lm[tip]);
        if (distMCP_TIP > distMCP_PIP * 1.5) return 1;  // Extended
        if (distMCP_TIP < distMCP_PIP * 0.8) return -1; // Curled
        return 0; // Neutral
    }

    d2(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
    near(a, b, t) { return this.d2(a, b) < t; }

    F(lm) {
        return {
            i: this.fingerState(lm, I_MCP, I_PIP, I_TIP) === 1,
            m: this.fingerState(lm, M_MCP, M_PIP, M_TIP) === 1,
            r: this.fingerState(lm, R_MCP, R_PIP, R_TIP) === 1,
            p: this.fingerState(lm, P_MCP, P_PIP, P_TIP) === 1,
            ic: this.fingerState(lm, I_MCP, I_PIP, I_TIP) === -1,
            mc: this.fingerState(lm, M_MCP, M_PIP, M_TIP) === -1,
            rc: this.fingerState(lm, R_MCP, R_PIP, R_TIP) === -1,
            pc: this.fingerState(lm, P_MCP, P_PIP, P_TIP) === -1
        };
    }

    looseFist(lm) {
        let curled = 0;
        if (lm[I_TIP].y > lm[I_PIP].y) curled++;
        if (lm[M_TIP].y > lm[M_PIP].y) curled++;
        if (lm[R_TIP].y > lm[R_PIP].y) curled++;
        if (lm[P_TIP].y > lm[P_PIP].y) curled++;
        return curled >= 3;
    }

    shrineScore(lm) {
        let s = 0;
        if (lm[M_TIP].y < lm[W_].y + 0.12) s++;
        if (lm[R_TIP].y < lm[W_].y + 0.12) s++;
        if (lm[I_TIP].y > lm[I_MCP].y - 0.10) s++;
        if (lm[P_TIP].y > lm[P_MCP].y - 0.10) s++;
        return s;
    }

    timeCellHand(lm) {
        const thumbUp = lm[TH_TIP].y < lm[W_].y - 0.05;
        const thumbExtended = this.d2(lm[TH_TIP], lm[W_]) > 0.09;
        const thumbActuallyUp = lm[TH_TIP].y < lm[I_MCP].y;
        const indexUp = lm[I_TIP].y < lm[I_MCP].y - 0.02;
        const indexExtended = this.d2(lm[I_TIP], lm[I_MCP]) > 0.10;
        const middleNotRaised = lm[M_TIP].y > lm[M_MCP].y - 0.02;
        const ringNotRaised = lm[R_TIP].y > lm[R_MCP].y - 0.02;
        const pinkyNotRaised = lm[P_TIP].y > lm[P_MCP].y - 0.02;
        return thumbUp && thumbExtended && thumbActuallyUp && indexUp && indexExtended && middleNotRaised && ringNotRaised && pinkyNotRaised;
    }

    yujiHand(lm) {
        const idxUp = lm[I_TIP].y < lm[I_MCP].y - 0.02;
        const idxExtended = this.d2(lm[I_TIP], lm[I_MCP]) > 0.10;
        const midDown = lm[M_TIP].y > lm[M_MCP].y - 0.05;
        const rngDown = lm[R_TIP].y > lm[R_MCP].y - 0.05;
        const pnkDown = lm[P_TIP].y > lm[P_MCP].y - 0.05;
        return idxUp && idxExtended && midDown && rngDown && pnkDown;
    }

    allDown(lm) { 
        const f = this.F(lm); 
        return !f.i && !f.m && !f.r && !f.p; 
    }

    // --- Main Logic ---

    detectDomain(hands) {
        if (!hands || hands.length === 0) return null;

        // 1. INDIVIDUAL HAND TECHNIQUES
        const techResults = hands.map(h => {
            const lm = h;
            const f = this.F(lm);
            // Blue: Index up, Middle down (Lenient)
            if (f.i && f.mc) return "Lapse Blue";
            // Red: Index, Middle, Ring all extended
            if (f.i && f.m && f.r) return "Reversal Red";
            return null;
        });

        const hasBlue = techResults.includes("Lapse Blue");
        const hasRed = techResults.includes("Reversal Red");

        if (hands.length >= 2 && hasBlue && hasRed) return "Hollow Purple";

        // 2. SINGLE HAND DOMAINS
        if (hands.length === 1) {
            const lm = hands[0];
            const f = this.F(lm);
            if (hasBlue) return "Lapse Blue";
            if (hasRed) return "Reversal Red";
            const middleNearIndex = this.near(lm[M_TIP], lm[I_TIP], 0.10) || this.near(lm[M_TIP], lm[I_PIP], 0.10);
            if (f.i && !f.r && !f.p && middleNearIndex) return "Unlimited Void";
        }

        // 3. TWO HAND DOMAINS
        if (hands.length >= 2) {
            const [a, b] = [hands[0], hands[1]];
            const horizDist = Math.abs(a[W_].x - b[W_].x);
            const verticalDist = Math.abs(a[W_].y - b[W_].y);

            if (this.timeCellHand(a) && this.timeCellHand(b)) return "Time Cell Moon Palace";

            if (horizDist > 0.35) {
                for (const [x, y] of [[a, b], [b, a]]) {
                    const fx = this.F(x), fy = this.F(y);
                    const xFist = (fx.ic && fx.mc && fx.rc && fx.pc) || this.looseFist(x);
                    const yOpenCount = (fy.i?1:0)+(fy.m?1:0)+(fy.r?1:0)+(fy.p?1:0);
                    if (xFist && yOpenCount >= 3) return "Authentic Mutual Love";
                }
            }

            if (horizDist <= 0.50 && verticalDist < 0.20) {
                if (this.yujiHand(a) && this.yujiHand(b) && this.d2(a[I_TIP], b[I_TIP]) < 0.30) return "Yuji Itadori";
                if (this.allDown(a) && this.allDown(b)) return "Chimera Shadow Garden";
                const sa = this.shrineScore(a), sb = this.shrineScore(b);
                if (sa >= 0 && sb >= 0 && ((sa>=3 && sb>=1) || (sb>=3 && sa>=1))) return "Malevolent Shrine";
                if (this.near(a[P_TIP], b[P_TIP], 0.08) && this.near(a[TH_TIP], b[TH_TIP], 0.12)) return "Self-Embodiment of Perfection";
            }

            if (verticalDist > 0.15 && this.d2(a[W_], b[W_]) > 0.20) {
                for (const [upper, lower] of [[a, b], [b, a]]) {
                    if (upper[W_].y >= lower[W_].y) continue;
                    const fu = this.F(upper), fl = this.F(lower);
                    const okCircle = this.near(upper[TH_TIP], upper[I_TIP], 0.22);
                    const okFingers = (fu.m?1:0)+(fu.r?1:0)+(fu.p?1:0) >= 1;
                    const lowerOpen = (fl.i?1:0)+(fl.m?1:0)+(fl.r?1:0)+(fl.p?1:0) >= 3;
                    if (okCircle && okFingers && lowerOpen) return "Idle Death Gamble";
                }
            }
        }
        return null;
    }

    update(hands) {
        const detected = this.detectDomain(hands);
        this.predictionHistory.push(detected || "");
        if (this.predictionHistory.length > this.historyMaxLen) this.predictionHistory.shift();
        const counts = {};
        this.predictionHistory.forEach(p => { if(p) counts[p] = (counts[p] || 0) + 1; });
        let topLabel = null, topCount = 0;
        for (const label in counts) { if (counts[label] > topCount) { topCount = counts[label]; topLabel = label; } }
        if (topCount >= 6) this.stableDomain = topLabel;
        else this.stableDomain = null;
        return this.stableDomain;
    }

    // --- VFX ---

    initStars(w, h, count = 150) {
        this.stars = [];
        for (let i = 0; i < count; i++) this.stars.push({ x: Math.random() * w, y: Math.random() * h, speed: 0.5 + Math.random() * 2.5 });
        this.symbols = [];
        for (let i = 0; i < 30; i++) this.symbols.push({ x: Math.random() * w, y: Math.random() * h, speed: 2 + Math.random() * 4, text: Math.floor(Math.random() * 10).toString() });
    }

    drawVFX(frameCanvas, stableDomain, hands) {
        if (!this.vfxCtx) return;
        const ctx = this.vfxCtx;
        const w = this.vfxCanvas.width;
        const h = this.vfxCanvas.height;
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1.0;
        ctx.clearRect(0, 0, w, h);
        if (!stableDomain) {
            this.slashes = []; this.flashCounter = 0; this.blueOrbRad = 0; this.redOrbRad = 0; this.purpleBeamProgress = 0;
            return;
        }

        const handList = hands ? Array.from(hands) : [];

        // Unified Coordinate Extraction (CSS scaleX(-1) handles the mirroring automatically)
        let primaryIdx = null;
        let secondIdx = null;
        let center = null;

        if (handList.length > 0) {
            const sorted = [...handList].sort((a, b) => a[0].x - b[0].x);
            if (sorted[0] && sorted[0][8]) primaryIdx = { x: sorted[0][8].x * w, y: sorted[0][8].y * h };
            if (sorted[1] && sorted[1][8]) secondIdx = { x: sorted[1][8].x * w, y: sorted[1][8].y * h };
            
            let sx = 0, sy = 0, count = 0;
            handList.forEach(hand => {
                for(let i=0; i<21; i++) { if(hand[i]) { sx += hand[i].x * w; sy += hand[i].y * h; count++; } }
            });
            if (count > 0) center = { x: sx / count, y: sy / count };
        }

        switch (stableDomain) {
            case "Unlimited Void": this.applyUnlimitedVoid(ctx, w, h); break;
            case "Malevolent Shrine": this.applyMalevolentShrine(ctx, w, h); break;
            case "Self-Embodiment of Perfection": this.applySelfEmbodiment(ctx, w, h); break;
            case "Authentic Mutual Love": this.applyAuthenticLove(ctx, w, h); break;
            case "Idle Death Gamble": this.applyIdleDeathGamble(ctx, w, h); break;
            case "Yuji Itadori": this.applyYujiDomain(ctx, w, h); break;
            case "Chimera Shadow Garden": this.applyChimera(ctx, w, h); break;
            case "Time Cell Moon Palace": this.applyNaoya(ctx, w, h); break;
            case "Lapse Blue": 
                if (primaryIdx) this.applyLapseBlue(ctx, primaryIdx); 
                else if (center) this.applyLapseBlue(ctx, center);
                else this.applyLapseBlue(ctx, { x: w * 0.25, y: h * 0.4 }); 
                break;
            case "Reversal Red": 
                if (primaryIdx) this.applyReversalRed(ctx, primaryIdx);
                else if (center) this.applyReversalRed(ctx, center);
                else this.applyReversalRed(ctx, { x: w * 0.75, y: h * 0.4 });
                break;
            case "Hollow Purple": 
                if (primaryIdx && secondIdx) this.applyHollowPurple(ctx, primaryIdx, secondIdx, w, h);
                else if (primaryIdx) this.applyHollowPurple(ctx, primaryIdx, primaryIdx, w, h);
                else if (center) this.applyHollowPurple(ctx, center, center, w, h);
                else this.applyHollowPurple(ctx, { x: w * 0.5, y: h * 0.4 }, { x: w * 0.5, y: h * 0.4 }, w, h);
                break;
        }
    }

    applyUnlimitedVoid(ctx, w, h) {
        this.voidPhase += 0.05;
        ctx.fillStyle = "rgba(0, 0, 0, 0.4)"; ctx.fillRect(0, 0, w, h);
        
        // Draw Unlimited Void background if loaded
        if (this.voidImg.complete) {
            ctx.save();
            ctx.scale(-1, 1);
            
            const imgAspect = this.voidImg.width / this.voidImg.height;
            const canvasAspect = w / h;
            let drawW, drawH;
            if (canvasAspect > imgAspect) {
                drawW = w;
                drawH = w / imgAspect;
            } else {
                drawH = h;
                drawW = h * imgAspect;
            }
            
            ctx.globalAlpha = 0.3 + 0.1 * Math.sin(this.voidPhase);
            ctx.drawImage(this.voidImg, -w + (w - drawW) / 2, (h - drawH) / 2, drawW, drawH);
            
            if (!this._voidLogged) { console.log('🌌 Unlimited Void Manifested!'); this._voidLogged = true; }
            ctx.restore();
        }

        ctx.fillStyle = "white";
        this.stars.forEach(s => { s.y = (s.y + s.speed) % h; ctx.beginPath(); ctx.arc(s.x, s.y, 1, 0, Math.PI * 2); ctx.fill(); });
        ctx.font = "15px monospace";
        this.symbols.forEach(s => { s.y = (s.y + s.speed) % h; ctx.fillText(s.text, s.x, s.y); });
    }

    applyMalevolentShrine(ctx, w, h) {
        ctx.fillStyle = "rgba(255, 0, 0, 0.35)"; ctx.fillRect(0, 0, w, h);
        
        // Draw Shrine background if loaded
        if (this.shrineImg.complete) {
            ctx.save();
            ctx.scale(-1, 1); // Un-mirror image
            const imgAspect = this.shrineImg.width / this.shrineImg.height;
            const canvasAspect = w / h;
            let drawW, drawH;
            if (canvasAspect > imgAspect) { drawW = w; drawH = w / imgAspect; } 
            else { drawH = h; drawW = h * imgAspect; }
            ctx.globalAlpha = 0.85; // Increased opacity for better visibility
            ctx.drawImage(this.shrineImg, -w + (w - drawW) / 2, (h - drawH) / 2, drawW, drawH);
            ctx.restore();
        }

        this.flashCounter++;
        if (this.flashCounter % 10 === 0) { ctx.fillStyle = "rgba(255, 255, 255, 0.8)"; ctx.fillRect(0, 0, w, h); }
        if (Math.random() < 0.6) {
            const x1 = Math.random() * w, y1 = Math.random() * h, length = 80 + Math.random() * 120, angle = (Math.random() - 0.5) * 1.6;
            this.slashes.push({ x1: x1, y1: y1, x2: x1 + length * Math.cos(angle), y2: y1 + length * Math.sin(angle), life: 3 + Math.floor(Math.random() * 4) });
        }
        ctx.strokeStyle = "white";
        this.slashes = this.slashes.filter(s => { ctx.lineWidth = s.life; ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(s.x2, s.y2); ctx.stroke(); s.life--; return s.life > 0; });
    }

    applySelfEmbodiment(ctx, w, h) {
        this.mahitoPhase += 0.02;
        
        // Draw Mahito background if loaded
        if (this.mahitoImg.complete) {
            ctx.save();
            ctx.scale(-1, 1);
            
            const imgAspect = this.mahitoImg.width / this.mahitoImg.height;
            const canvasAspect = w / h;
            let drawW, drawH;
            if (canvasAspect > imgAspect) {
                drawW = w;
                drawH = w / imgAspect;
            } else {
                drawH = h;
                drawW = h * imgAspect;
            }
            
            ctx.globalAlpha = 0.4 + 0.1 * Math.sin(this.mahitoPhase * 2);
            ctx.drawImage(this.mahitoImg, -w + (w - drawW) / 2, (h - drawH) / 2, drawW, drawH);
            
            if (!this._mahitoLogged) { console.log('🤚 Self-Embodiment Manifested!'); this._mahitoLogged = true; }
            ctx.restore();
        } else {
            if (!this._mahitoLoadWarned) { console.warn('⚠️ Mahito image not yet loaded'); this._mahitoLoadWarned = true; }
        }

        ctx.fillStyle = `rgba(150, 0, 150, ${0.15 + 0.05 * Math.sin(this.mahitoPhase * 4)})`;
        ctx.fillRect(0, 0, w, h);
    }

    applyAuthenticLove(ctx, w, h) {
        this.yutaPhase += 0.02;
        
        // Draw Rika background if loaded
        if (this.rikaImg.complete) {
            ctx.save();
            // Since the CANVAS element is mirrored via CSS transform: scaleX(-1),
            // our drawing context is mirrored. We must UN-MIRROR the image so she looks correct.
            ctx.scale(-1, 1);
            
            const imgAspect = this.rikaImg.width / this.rikaImg.height;
            const canvasAspect = w / h;
            let drawW, drawH;
            if (canvasAspect > imgAspect) {
                drawW = w;
                drawH = w / imgAspect;
            } else {
                drawH = h;
                drawW = h * imgAspect;
            }
            
            ctx.globalAlpha = 0.3 + 0.1 * Math.sin(this.yutaPhase);
            // Coordinates are -w to 0 because of scale(-1, 1)
            ctx.drawImage(this.rikaImg, -w + (w - drawW) / 2, (h - drawH) / 2, drawW, drawH);
            
            if (!this._rikaLogged) { console.log('👻 Rika Manifested!'); this._rikaLogged = true; }
            ctx.restore();
        } else {
            // Log once if not complete
            if (!this._rikaLoadWarned) { console.warn('⚠️ Rika image not yet loaded'); this._rikaLoadWarned = true; }
        }

        ctx.fillStyle = "rgba(180, 100, 255, 0.12)"; ctx.fillRect(0, 0, w, h);
        const brightness = 0.05 * Math.sin(this.yutaPhase);
        ctx.fillStyle = `rgba(255, 255, 255, ${Math.max(0, brightness)})`; ctx.fillRect(0, 0, w, h);
    }

    applyIdleDeathGamble(ctx, w, h) {
        this.hakariPhase++;
        
        // Draw Hakari background if loaded
        if (this.hakariImg.complete) {
            ctx.save();
            ctx.scale(-1, 1);
            
            const imgAspect = this.hakariImg.width / this.hakariImg.height;
            const canvasAspect = w / h;
            let drawW, drawH;
            if (canvasAspect > imgAspect) {
                drawW = w;
                drawH = w / imgAspect;
            } else {
                drawH = h;
                drawW = h * imgAspect;
            }
            
            ctx.globalAlpha = 0.5 + 0.1 * Math.sin(this.hakariPhase * 0.1);
            ctx.drawImage(this.hakariImg, -w + (w - drawW) / 2, (h - drawH) / 2, drawW, drawH);
            
            if (!this._hakariLogged) { console.log('🎰 Jackpot! Idle Death Gamble Manifested!'); this._hakariLogged = true; }
            ctx.restore();
        }

        ctx.fillStyle = "rgba(255, 215, 0, 0.2)"; ctx.fillRect(0, 0, w, h);
        if (this.hakariPhase % 3 === 0) this.slotNumbers = [Math.floor(Math.random()*10).toString(), Math.floor(Math.random()*10).toString(), Math.floor(Math.random()*10).toString()];
        ctx.fillStyle = "white"; ctx.font = "bold 40px Arial"; ctx.textAlign = "center";
        ctx.fillText(`[${this.slotNumbers[0]}] [${this.slotNumbers[1]}] [${this.slotNumbers[2]}]`, w/2, h - 50);
        if (this.confetti.length === 0) { for(let i=0; i<50; i++) this.confetti.push({ x: Math.random()*w, y: Math.random()*h, speed: 2+Math.random()*3, color: ["#FFFF00", "#FFD700", "#FFFFFF"][Math.floor(Math.random()*3)] }); }
        this.confetti.forEach(p => { p.y = (p.y + p.speed) % h; ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI*2); ctx.fill(); });
    }

    applyYujiDomain(ctx, w, h) {
        this.yujiPhase += 0.1;
        ctx.fillStyle = `rgba(0, 255, 0, ${0.1 * Math.abs(Math.sin(this.yujiPhase * 4))})`; ctx.fillRect(0, 0, w, h);
        this.shockwaveRad = (this.shockwaveRad + 10) % Math.max(w, h);
        ctx.strokeStyle = "rgba(100, 255, 100, 0.5)"; ctx.lineWidth = 5 * (1 - this.shockwaveRad / Math.max(w, h));
        ctx.beginPath(); ctx.arc(w/2, h/2, this.shockwaveRad, 0, Math.PI * 2); ctx.stroke();
    }

    applyChimera(ctx, w, h) {
        this.chimeraPhase++;
        ctx.fillStyle = "rgba(20, 20, 40, 0.4)"; ctx.fillRect(0, 0, w, h);
        
        // Draw Chimera background if loaded
        if (this.chimeraImg.complete) {
            ctx.save();
            ctx.scale(-1, 1);
            
            const imgAspect = this.chimeraImg.width / this.chimeraImg.height;
            const canvasAspect = w / h;
            let drawW, drawH;
            if (canvasAspect > imgAspect) {
                drawW = w;
                drawH = w / imgAspect;
            } else {
                drawH = h;
                drawW = h * imgAspect;
            }
            
            ctx.globalAlpha = 0.4 + 0.1 * Math.sin(this.chimeraPhase * 0.1);
            ctx.drawImage(this.chimeraImg, -w + (w - drawW) / 2, (h - drawH) / 2, drawW, drawH);
            
            if (!this._chimeraLogged) { console.log('🌑 Chimera Shadow Garden Manifested!'); this._chimeraLogged = true; }
            ctx.restore();
        }

        ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
        for (let i = 0; i < 5; i++) {
            const time = (Date.now() / 1000 + i) % 2, radius = time * 100;
            ctx.beginPath(); ctx.arc(w/2 + Math.sin(i) * 200, h, radius, 0, Math.PI * 2); ctx.fill();
        }
    }

    applyNaoya(ctx, w, h) {
        ctx.fillStyle = "rgba(255, 100, 150, 0.2)"; ctx.fillRect(0, 0, w, h);
        const pulse = Math.abs(Math.sin(Date.now() / 200)) * 0.2;
        
        // Draw Naoya background if loaded
        if (this.naoyaImg.complete) {
            ctx.save();
            ctx.scale(-1, 1);
            
            const imgAspect = this.naoyaImg.width / this.naoyaImg.height;
            const canvasAspect = w / h;
            let drawW, drawH;
            if (canvasAspect > imgAspect) {
                drawW = w;
                drawH = w / imgAspect;
            } else {
                drawH = h;
                drawW = h * imgAspect;
            }
            
            ctx.globalAlpha = 0.4 + pulse;
            ctx.drawImage(this.naoyaImg, -w + (w - drawW) / 2, (h - drawH) / 2, drawW, drawH);
            
            if (!this._naoyaLogged) { console.log('📽️ Time Cell Moon Palace Manifested!'); this._naoyaLogged = true; }
            ctx.restore();
        }

        ctx.fillStyle = `rgba(255, 255, 255, ${pulse})`; ctx.fillRect(0, 0, w, h);
    }

    applyLapseBlue(ctx, pos) {
        this.blueOrbRad = (this.blueOrbRad + 1.5) % 25;
        const r = 55 + this.blueOrbRad;

        // Energy Aura (Safe Concentric Layers)
        ctx.fillStyle = "rgba(0, 100, 255, 0.15)";
        ctx.beginPath(); ctx.arc(pos.x, pos.y, r + 40, 0, Math.PI * 2); ctx.fill();

        ctx.fillStyle = "rgba(0, 150, 255, 0.4)";
        ctx.beginPath(); ctx.arc(pos.x, pos.y, r + 20, 0, Math.PI * 2); ctx.fill();

        ctx.fillStyle = "#0077FF"; // Main Body
        ctx.strokeStyle = "white";
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

        // Unstable Core
        const corePulse = 5 * Math.sin(Date.now() / 50);
        ctx.fillStyle = "white";
        ctx.beginPath(); ctx.arc(pos.x, pos.y, 15 + corePulse, 0, Math.PI * 2); ctx.fill();
    }

    applyReversalRed(ctx, pos) {
        this.redOrbRad = (this.redOrbRad + 1.5) % 25;
        const r = 55 + this.redOrbRad;

        // Energy Aura
        ctx.fillStyle = "rgba(255, 50, 50, 0.15)";
        ctx.beginPath(); ctx.arc(pos.x, pos.y, r + 40, 0, Math.PI * 2); ctx.fill();

        ctx.fillStyle = "rgba(255, 80, 80, 0.4)";
        ctx.beginPath(); ctx.arc(pos.x, pos.y, r + 20, 0, Math.PI * 2); ctx.fill();

        ctx.fillStyle = "#FF3333"; // Main Body
        ctx.strokeStyle = "white";
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

        // Unstable Core
        const corePulse = 5 * Math.sin(Date.now() / 50);
        ctx.fillStyle = "white";
        ctx.beginPath(); ctx.arc(pos.x, pos.y, 15 + corePulse, 0, Math.PI * 2); ctx.fill();
    }

    applyHollowPurple(ctx, p1, p2, w, h) {
        this.purpleBeamProgress += 0.04; if (this.purpleBeamProgress > 1) this.purpleBeamProgress = 0;
        const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y), center = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };

        if (dist < 200) {
            const r = 160 * (1 + this.purpleBeamProgress * 0.1);

            // Outer Purple Aura
            ctx.fillStyle = "rgba(148, 0, 211, 0.15)";
            ctx.beginPath(); ctx.arc(center.x, center.y, r + 60, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = "rgba(180, 0, 255, 0.3)";
            ctx.beginPath(); ctx.arc(center.x, center.y, r + 30, 0, Math.PI * 2); ctx.fill();

            // Core Energy
            ctx.fillStyle = "#9400D3"; 
            ctx.strokeStyle = "white";
            ctx.lineWidth = 6;
            ctx.beginPath(); ctx.arc(center.x, center.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

            ctx.fillStyle = "white";
            const corePulse = 10 * Math.sin(Date.now() / 40);
            ctx.beginPath(); ctx.arc(center.x, center.y, 50 + corePulse, 0, Math.PI * 2); ctx.fill();
        } else {
            // High Visibility Tracking Orbs
            this.applyLapseBlue(ctx, p1);
            this.applyReversalRed(ctx, p2);

            // Energy Arc
            ctx.strokeStyle = "rgba(255, 255, 255, 0.6)";
            ctx.lineWidth = 4;
            ctx.setLineDash([15, 10]);
            ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
            ctx.setLineDash([]);
        }
    }
}

window.DomainExpansionGame = DomainExpansionGame;
