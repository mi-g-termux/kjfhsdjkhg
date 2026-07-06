/**
 * flyToCart — animated "add to cart" effect.
 *
 * Clones the product image and animates it along an arc into the navbar cart
 * icon (`#navbar-cart-trigger`), then gives the cart a little bump. Purely
 * cosmetic: it never blocks or delays the real add-to-cart logic, and it fails
 * silently if anything is missing (no image, no cart icon, SSR, etc.).
 *
 * Respects `prefers-reduced-motion`: users who opt out only get the subtle cart
 * bump, no flying image.
 *
 * Usage:
 *   onClick={(e) => { addToCart(...); flyToCart(e.currentTarget); }}
 *   // or pass an explicit image url:
 *   flyToCart(e.currentTarget, product.coverImage);
 */

function prefersReducedMotion(): boolean {
	try {
		return !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
	} catch {
		return false;
	}
}

/** Little squeeze/pulse on the cart icon so the drop feels "received". */
function bumpCart(cartEl: HTMLElement): void {
	try {
		cartEl.animate(
			[
				{ transform: 'scale(1)' },
				{ transform: 'scale(1.35)' },
				{ transform: 'scale(0.92)' },
				{ transform: 'scale(1)' },
			],
			{ duration: 380, easing: 'ease-out' },
		);
	} catch {
		/* no-op */
	}
}

/** Resolve the best image element to clone, given the click origin. */
function resolveSourceImage(
	origin: HTMLElement | null,
	imageUrl?: string,
): { src?: string; rect: DOMRect } | null {
	if (!origin) return null;

	// 1) Product grid card: the button lives inside `#product-card-<id>`.
	const card = origin.closest<HTMLElement>('[id^="product-card-"]');
	// 2) Product detail page: main image is tagged with `data-pdp-cover`.
	const pdpImg =
		document.querySelector<HTMLImageElement>('[data-pdp-cover] img') ||
		document.querySelector<HTMLImageElement>('[data-pdp-cover]');

	const imgEl =
		card?.querySelector<HTMLImageElement>('img') ||
		(pdpImg instanceof HTMLImageElement ? pdpImg : null) ||
		origin.querySelector<HTMLImageElement>('img');

	const anchor: HTMLElement = imgEl || origin;
	const rect = anchor.getBoundingClientRect();
	if (rect.width === 0 || rect.height === 0) return null;

	const src =
		imageUrl ||
		(imgEl && (imgEl.currentSrc || imgEl.src)) ||
		undefined;

	return { src, rect };
}

export function flyToCart(origin: HTMLElement | null, imageUrl?: string): void {
	try {
		if (typeof window === 'undefined' || typeof document === 'undefined') return;
		const cartEl = document.getElementById('navbar-cart-trigger');
		if (!cartEl) return;

		// Reduced motion: just acknowledge with a bump, skip the flight.
		if (prefersReducedMotion()) {
			bumpCart(cartEl);
			return;
		}

		const source = resolveSourceImage(origin, imageUrl);
		if (!source) return;

		const { src, rect: startRect } = source;
		const endRect = cartEl.getBoundingClientRect();

		// Keep the flyer reasonably sized regardless of the source dimensions.
		const size = Math.min(Math.max(startRect.width, 48), 120);
		const startX = startRect.left + startRect.width / 2;
		const startY = startRect.top + startRect.height / 2;
		const endX = endRect.left + endRect.width / 2;
		const endY = endRect.top + endRect.height / 2;

		let flyer: HTMLElement;
		if (src) {
			const img = document.createElement('img');
			img.src = src;
			img.alt = '';
			img.style.objectFit = 'contain';
			img.style.background = '#ffffff';
			flyer = img;
		} else {
			// No image (emoji products etc.) — fly a small cart-colored dot.
			flyer = document.createElement('div');
			flyer.style.background = '#10b981';
		}

		Object.assign(flyer.style, {
			position: 'fixed',
			left: `${startX - size / 2}px`,
			top: `${startY - size / 2}px`,
			width: `${size}px`,
			height: `${size}px`,
			borderRadius: '16px',
			boxShadow: '0 10px 25px rgba(0,0,0,0.18)',
			border: '1px solid rgba(0,0,0,0.06)',
			zIndex: '99999',
			pointerEvents: 'none',
			willChange: 'transform, opacity',
		} as CSSStyleDeclaration);

		document.body.appendChild(flyer);

		const dx = endX - startX;
		const dy = endY - startY;
		// Arc: lift up a little at the midpoint before diving into the cart.
		const lift = Math.min(140, Math.abs(dy) * 0.5 + 60);

		const anim = flyer.animate(
			[
				{ transform: 'translate(0px, 0px) scale(1) rotate(0deg)', opacity: 1, offset: 0 },
				{
					transform: `translate(${dx * 0.5}px, ${dy * 0.5 - lift}px) scale(0.7) rotate(-12deg)`,
					opacity: 0.95,
					offset: 0.6,
				},
				{
					transform: `translate(${dx}px, ${dy}px) scale(0.12) rotate(6deg)`,
					opacity: 0.35,
					offset: 1,
				},
			],
			{ duration: 750, easing: 'cubic-bezier(0.5, -0.2, 0.3, 1)', fill: 'forwards' },
		);

		const cleanup = () => {
			try { flyer.remove(); } catch { /* no-op */ }
			bumpCart(cartEl);
		};
		anim.onfinish = cleanup;
		anim.oncancel = cleanup;
		// Safety fallback in case animation events don't fire.
		window.setTimeout(cleanup, 1100);
	} catch {
		/* Animation is purely cosmetic — never let it break add-to-cart. */
	}
}
