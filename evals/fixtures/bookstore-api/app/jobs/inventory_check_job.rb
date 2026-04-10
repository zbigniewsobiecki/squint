class InventoryCheckJob < ApplicationJob
  queue_as :default

  def perform(order)
    order.order_items.includes(:book).each do |item|
      stock_info = InventoryService.check_stock(item.book)

      if stock_info[:low_stock]
        Rails.logger.warn(
          "Low stock alert: #{stock_info[:title]} has #{stock_info[:stock_count]} remaining"
        )
        notify_admin(stock_info)
      end
    end
  end

  private

  def notify_admin(stock_info)
    AdminNotifier.low_stock(stock_info).deliver_later
  end
end
