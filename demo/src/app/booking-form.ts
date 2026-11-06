import { Component, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';

@Component({
  selector: 'demo-booking-form',
  imports: [ReactiveFormsModule],
  templateUrl: './booking-form.html',
  styleUrl: './booking-form.css',
})
export class BookingForm {
  protected readonly form = inject(NonNullableFormBuilder).group({
    name: ['', [Validators.required, Validators.maxLength(80)]],
    email: ['', [Validators.required, Validators.email]],
    destination: ['Lisbon', Validators.required],
    travellers: [2, [Validators.required, Validators.min(1), Validators.max(8)]],
  });
  protected readonly sent = signal(false);

  protected submit() {
    if (this.form.invalid) return this.form.markAllAsTouched();
    this.sent.set(true);
  }
}
