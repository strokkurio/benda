import { Component, signal } from '@angular/core';
import { DestinationCard, type Destination } from './destination-card';

@Component({
  selector: 'demo-destinations',
  imports: [DestinationCard],
  templateUrl: './destinations.html',
  styleUrl: './destinations.css',
})
export class Destinations {
  protected readonly destinations = signal<Destination[]>([
    { name: 'Lisbon', country: 'Portugal', nights: 4, price: 640, rating: 4.8, tag: 'City' },
    { name: 'Lofoten', country: 'Norway', nights: 6, price: 1180, rating: 4.9, tag: 'Nature' },
    { name: 'Kyoto', country: 'Japan', nights: 8, price: 2140, rating: 4.7, tag: 'Culture' },
    { name: 'Reykjavik', country: 'Iceland', nights: 5, price: 980, rating: 4.9, tag: 'Nature' },
  ]);
}
