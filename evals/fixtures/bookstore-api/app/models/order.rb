class Order < ApplicationRecord
  STATUS_PENDING = 'pending'
  STATUS_CONFIRMED = 'confirmed'
  STATUS_CANCELLED = 'cancelled'

  STATUSES = [STATUS_PENDING, STATUS_CONFIRMED, STATUS_CANCELLED].freeze

  belongs_to :user
  has_many :order_items, dependent: :destroy
  has_many :books, through: :order_items

  validates :status, inclusion: { in: STATUSES }
  validates :total_cents, numericality: { greater_than_or_equal_to: 0 }

  after_create :send_confirmation_email
  after_create :enqueue_inventory_check

  scope :confirmed, -> { where(status: STATUS_CONFIRMED) }
  scope :for_user, ->(user_id) { where(user_id: user_id) }

  def confirm!
    update!(status: STATUS_CONFIRMED)
  end

  def cancel!
    return false if status == STATUS_CANCELLED

    update!(status: STATUS_CANCELLED)
    order_items.each { |item| item.book.update!(stock_count: item.book.stock_count + item.quantity) }
    true
  end

  def item_count
    order_items.sum(:quantity)
  end

  private

  def send_confirmation_email
    OrderMailer.confirmation(self).deliver_later
  end

  def enqueue_inventory_check
    InventoryCheckJob.perform_later(self)
  end
end
