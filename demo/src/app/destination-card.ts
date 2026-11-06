import { CurrencyPipe } from '@angular/common';
import { Component, input } from '@angular/core';

export interface Destination {
  name: string;
  country: string;
  nights: number;
  price: number;
  rating: number;
  tag: string;
}

@Component({
  selector: 'demo-destination-card',
  imports: [CurrencyPipe],
  templateUrl: './destination-card.html',
  styleUrl: './destination-card.css',
})
export class DestinationCard {
  readonly destination = input.required<Destination>();
}
