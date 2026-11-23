<script>
  import { pageHref } from '../lib/route.js';

  /** @type {{title?: string, children: import('svelte').Snippet}} */
  let { title, children } = $props();

  const links = /** @type {const} */ ([
    ['home', 'Trang chủ'],
    ['disclaimer', 'Giới thiệu'],
    ['contact', 'Liên hệ'],
    ['donate', 'Ủng hộ'],
    ['credits', 'Ghi công'],
  ]);
</script>

<div class="flex min-h-screen flex-col bg-white text-stone-900">
  <header class="border-b-2 border-kepi-500 bg-white shadow-[inset_0_-4px_0_var(--color-police-500)]">
    <nav class="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-3">
      <a href={pageHref('home')} class="text-lg font-bold text-stone-900">Lái sao cho đúng</a>
      <ul class="flex gap-4 text-sm">
        {#each links.slice(1) as [name, label] (name)}
          <li><a class="text-stone-700 hover:text-police-700 hover:underline" href={pageHref(name)} data-testid="nav-{name}">{label}</a></li>
        {/each}
      </ul>
    </nav>
  </header>
  <main class="mx-auto w-full max-w-5xl flex-1 px-6 py-8">
    {#if title}
      <h1 class="mb-6 text-3xl font-bold">{title}</h1>
    {/if}
    {@render children()}
  </main>
  <footer class="border-t border-stone-200 bg-stone-50 py-4 text-center text-xs text-stone-600">
    Trò chơi mô phỏng, không phải tư vấn pháp lý. Mã nguồn theo giấy phép Apache-2.0.
  </footer>
</div>
