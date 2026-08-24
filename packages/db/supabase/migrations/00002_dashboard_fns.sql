-- Dashboard aggregate functions (SPEC section 7). SECURITY INVOKER: RLS on the
-- underlying tables applies to the calling user — no data crosses owners.

create or replace function public.dashboard_volume(p_monitor uuid, p_days int default 30)
returns table (day date, source text, items bigint, noise bigint)
language sql stable security invoker as $$
  select
    r.posted_at::date as day,
    r.source,
    count(*) as items,
    count(*) filter (where c.relevant = false or c.signal_type = 'noise') as noise
  from raw_items r
  left join item_classifications c
    on c.monitor_id = r.monitor_id and c.source = r.source and c.external_id = r.external_id
  where r.monitor_id = p_monitor
    and r.posted_at >= current_date - p_days
  group by 1, 2
  order by 1, 2
$$;

create or replace function public.dashboard_sentiment(p_monitor uuid, p_days int default 30)
returns table (day date, sentiment text, items bigint)
language sql stable security invoker as $$
  select
    r.posted_at::date as day,
    c.sentiment,
    count(*) as items
  from item_classifications c
  join raw_items r
    on r.monitor_id = c.monitor_id and r.source = c.source and r.external_id = c.external_id
  where c.monitor_id = p_monitor
    and c.relevant = true
    and r.posted_at >= current_date - p_days
  group by 1, 2
  order by 1, 2
$$;
