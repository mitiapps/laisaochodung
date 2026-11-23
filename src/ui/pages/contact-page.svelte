<script>
  import PageShell from '../layout/page-shell.svelte';
  import { SITE, isContactHref } from '../../config/site.js';

  const channels = SITE.contacts.filter((c) => isContactHref(c.href));
</script>

<PageShell title="Liên hệ">
  <div class="space-y-4 text-slate-200" data-testid="page-contact">
    <p>
      Báo lỗi luật, lỗi chấm điểm, biển báo sai hoặc góp ý cho trò chơi. Ưu tiên theo thứ tự dưới đây:
    </p>
    {#if channels.length > 0}
      <ol class="list-decimal space-y-2 pl-6">
        {#each channels as c (c.id)}
          <li>
            <span class="text-slate-400">{c.label}:</span>
            <a
              class="text-sky-300 underline"
              href={c.href}
              target={c.href.startsWith('mailto:') ? undefined : '_blank'}
              rel="noopener noreferrer"
              data-testid={`contact-${c.id}`}>{c.text}</a
            >
          </li>
        {/each}
      </ol>
    {:else}
      <p class="text-slate-400" data-testid="contact-missing">Kênh liên hệ chưa thiết lập.</p>
    {/if}
  </div>
</PageShell>
