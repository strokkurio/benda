import { Component } from '@angular/core';
import { Hero } from './hero';
import { Destinations } from './destinations';
import { BookingForm } from './booking-form';

@Component({
  selector: 'demo-root',
  imports: [Hero, Destinations, BookingForm],
  template: `
    <header class="header">
      <div class="container header-inner">
        <a class="logo" href="#">Northwind Trips</a>
        <nav aria-label="Main">
          <a href="#destinations">Destinations</a>
          <a href="#booking">Book</a>
        </nav>
      </div>
    </header>
    <main>
      <demo-hero />
      <demo-destinations />
      <demo-booking-form />
    </main>
    <footer class="footer">
      <div class="container">© Northwind Trips – a demo app for Benda</div>
    </footer>
  `,
  styles: `
    .header {
      background: var(--color-surface);
      border-bottom: 1px solid var(--color-border);
    }
    .header-inner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: 64px;
    }
    .logo {
      color: var(--color-accent);
      font-weight: 700;
      font-size: 20px;
      text-decoration: none;
    }
    nav {
      display: flex;
      gap: 24px;
    }
    nav a {
      color: var(--color-muted);
      text-decoration: none;
    }
    .footer {
      padding: 32px 0;
      color: var(--color-muted);
      font-size: 14px;
    }
  `,
})
export class App {}
